// createAgent, receive and receiveAndWait (Spec section 3).
//
// API-1: `receive` writes the message down and returns. Finding the person
// and inserting the inbox row are the only things it waits for, so a
// webhook can acknowledge in milliseconds however long the brain takes.
//
// API-2: `receiveAndWait` is for a caller that wants the answer, not just
// the acknowledgement: a test, an evals adapter, or a terminal.
//
// The turn still runs in this process. T2.2 moves it behind a person lease
// and a worker, so a turn survives the process that received the message.
// Until then `settled()` is how a caller waits for work already in flight.
import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { OpenboxConfig } from "../config/index.ts"
import type { Brain } from "../providers/brains/types.ts"
import {
  createStore,
  isUniqueViolation,
  type InboxRow,
  type MessageRow,
  type PersonRow,
  type Store,
} from "../store/index.ts"
import { createToolRegistry, type Tool, type ToolRegistry } from "../tools/index.ts"
import { taskTools, openTasks, TASK_EXPIRE_JOB } from "../tools/tasks.ts"
import { factTools, factsFor } from "../tools/facts.ts"
import { operatorTools } from "../tools/operator.ts"
import { handoverTools } from "../tools/handover.ts"
import type { TaskRow } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"
import { systemClock } from "../testing/clock.ts"
import { createEvents, type EventFailure, type EventSink, type EventWriter } from "./events.ts"
import { createLeases, FREE } from "./lease.ts"
import {
  asCommand,
  createHandovers,
  isCommand,
  nameOf,
  HANDOVER_IDLE_JOB,
  HANDOVER_WAITING_JOB,
  type Handovers,
} from "./handover.ts"
import { createJobs, type Jobs } from "./jobs.ts"
import { createOutbox, type Outbox } from "./outbox.ts"
import {
  costOf,
  createLimits,
  BRAINS_FAILED_REPLY,
  RATE_LIMIT_REPLY,
  STEP_CAP_REPLY,
  type Limits,
} from "./limits.ts"
import {
  createProactive,
  PROACTIVE_JOB,
  type ScheduleRequest,
  type Scheduled,
  type TriggerRequest,
} from "./proactive.ts"
import { createWorker } from "./worker.ts"
import type { Inbound, Sender } from "./sender.ts"
import { runTurn, type TurnResult } from "./turn.ts"
import { createConfirmations, EXPIRE_JOB, type Confirmations, type Resolution } from "./confirm.ts"
import { toolContext } from "./tool-context.ts"
import type { DecisionModel } from "../providers/decision/types.ts"
import { ensureVersionRow, versionHash } from "./version.ts"

export interface Deps {
  /** The first is the primary, the rest are fallbacks in order. */
  brains: Brain[]
  /**
   * DM-1: what routing and the gate ask. Required, because config always
   * names one, so an agent that could not ask would be misconfigured
   * rather than simply unrouted. Tests pass `scriptedDecisionModel`.
   */
  decisionModel: DecisionModel
  db: SupabaseClient
  sender: Sender
  clock?: Clock | undefined
  /** EVT-1: told about every event, alongside the agent's own table. */
  events?: EventSink | undefined
  // transcriber and retriever join Deps as the features that need them
  // land, in M7 and M8. They are left out rather than stubbed, so nothing
  // can quietly depend on a fake.
}

export interface AgentOptions {
  config: OpenboxConfig
  deps: Deps
  /** The static system prompt, prompt.md in a real agent (SKILL-8). */
  prompt: string
  tools?: Tool[]
  /**
   * CONF-3's `OPENBOX_SECRET`, which signs Confirm and Cancel payloads.
   *
   * Not in config, because CFG-2 keeps credentials out of it. Required
   * only for an agent that has an irreversible tool: nothing else ever
   * signs anything, and an agent that can only read should not need a
   * secret to start.
   */
  secret?: string | undefined
  /** Told when an event could not be recorded. A turn never fails for it. */
  onEventError?: ((failure: EventFailure) => void) | undefined
  /**
   * Told when the worker itself went wrong, rather than a turn: a claim
   * that failed, a lease lost mid turn, a database that refused a read.
   * The worker carries on looking for work either way.
   */
  onWorkerError?: ((error: unknown) => void) | undefined
  /**
   * Told when a turn ended in a way the core did not plan for. `receive`
   * has already returned by then, so this is the only place a glue can
   * learn about it as it happens.
   */
  onTurnError?: ((failure: TurnFailure) => void) | undefined
}

export interface ReceiveResult {
  inboxId: string
  duplicate: boolean
}

export interface ReceiveAndWaitResult extends ReceiveResult {
  /**
   * The turn this message was handled by. Absent when the message was a
   * duplicate of one whose turn has already finished, so there was nothing
   * left to wait for.
   */
  turn?: TurnResult | undefined
}

/** A turn that ended in a way the core did not plan for. */
export interface TurnFailure {
  /** Every message the failed turn had taken. */
  inboxIds: string[]
  personId: string
  turnId: string | undefined
  error: unknown
}

export interface Agent {
  readonly config: OpenboxConfig
  readonly store: Store
  readonly tools: ToolRegistry
  readonly events: EventWriter
  /** LEARN-2: the hash of the prompt, tools, config and core version. */
  readonly versionHash: string
  /** LOOP-2: how this process names itself on the leases it holds. */
  readonly owner: string
  /** LOOP-11: where replies go before they go out. */
  readonly outbox: Outbox
  /** The job loop, and the sweep that recovers abandoned turns. */
  readonly jobs: Jobs
  /**
   * CONF-1 to CONF-8, or undefined when the agent has no irreversible
   * tool and so nothing to confirm.
   *
   * Exposed because CONF-5's claim can only be proven by resolving the
   * same action twice at once, and the person lease deliberately stops
   * that happening through `receive`. An evals adapter wanting to see a
   * pending action resolved without a channel needs the same door.
   */
  readonly confirmations: Confirmations | undefined
  /**
   * HAND-1 to HAND-3, for a glue or an evals adapter that has to open
   * or take one without a conversation to do it in.
   */
  readonly handovers: Handovers
  /**
   * LIMIT-1 to LIMIT-3, for a glue that wants to show today's spend, and
   * for a test that has to put the agent at its cap without spending
   * anything.
   */
  readonly limits: Limits
  /** API-1: writes the message down and returns. The turn runs behind it. */
  receive(inbound: Inbound): Promise<ReceiveResult>
  /**
   * API-2: the same, then waits until the message has been handled.
   *
   * Needs this process to be running the worker, so `start()` comes first.
   * A webhook that only hands messages over uses `receive`.
   */
  receiveAndWait(inbound: Inbound): Promise<ReceiveAndWaitResult>
  /**
   * PRO-1: a message at a time, as a job, so a restart does not lose it.
   *
   * Either fixed (`text` or `template`) or composed (`compose`), and
   * exactly one of the three. The same `dedupeKey` twice books one
   * message.
   */
  schedule(request: ScheduleRequest): Promise<Scheduled>
  /**
   * PRO-2: a message about something that happened outside the
   * conversation, which the brain writes from the event and its data.
   */
  trigger(request: TriggerRequest): Promise<Scheduled>
  /** Starts the worker (LOOP-2). Nothing is handled here until it runs. */
  start(): void
  /** Stops it, finishing the turns in flight and giving up every lease. */
  stop(): Promise<void>
  /** How many turns are running right now. */
  inFlight(): number
  /**
   * Resolves once there is no work left that could run right now.
   *
   * "Right now" is the catch: a message still inside its burst window
   * (LOOP-3) is waiting rather than ready, so this returns while it sits
   * there. A caller that wants that message answered has to let the window
   * pass first. The alternative, waiting for anything pending at all,
   * never returns under a frozen clock.
   */
  settled(): Promise<void>
}

/**
 * Outcomes where nobody was answered, so the inbox row stays findable.
 *
 * `no_reply` is not one of them: the brain chose to say nothing, which is
 * a handled turn. `replied` obviously is not.
 */
/** HAND-2: how much of the conversation the summary is written from. */
const SUMMARY_MESSAGES = 12

/** HAND-2: three lines, for a colleague who is about to take it over. */
const SUMMARY_PROMPT = [
  "A colleague is about to take over this conversation from you.",
  "Write exactly three short lines, one per line, with no greeting and no advice:",
  "1. what this person wants, 2. what has happened so far, 3. what is unresolved.",
].join(" ")

const UNANSWERED = new Set<TurnResult["outcome"]>(["failed", "brains_failed", "step_cap"])

/**
 * ROLE-4: what a blocked person's turn did, which is nothing.
 *
 * Not in UNANSWERED above: the message was handled correctly by not
 * being answered, so the recovery sweep must leave it alone.
 */
const nothingHappened = (outcome: TurnResult["outcome"]): TurnResult => ({
  steps: 0,
  costUsd: 0,
  brainsUsed: [],
  toolsRun: [],
  routed: [],
  droppedCalls: [],
  handoverDue: [],
  outcome,
})

/**
 * LOOP-5 step 2: what the person is told when they opt out, and back in.
 *
 * Fixed lines, not the brain's. A person who has just asked to be left
 * alone should not have to read a sentence somebody's model wrote, and
 * the way back has to be in the same breath or it is not a way back.
 */
export const OPTED_OUT_REPLY =
  "You will not get any more messages from us. Send START whenever you want them again."
export const OPTED_IN_REPLY =
  "You will get messages from us again. Send STOP any time to stop them."

/**
 * LOOP-5 step 2: which of the two words this message is, if it is one.
 *
 * "Exactly STOP or START (any case)" in the Spec's words. Surrounding
 * space is ignored, because a phone keyboard adds one and nobody means
 * anything different by it. Anything longer is a sentence for the brain:
 * "stop by on friday" is not an opt out.
 */
export function optOutWord(text: string | null): "stop" | "start" | undefined {
  const word = (text ?? "").trim().toLowerCase()
  if (word === "stop") return "stop"
  if (word === "start") return "start"
  return undefined
}

/** One reply per set of messages answered, however many turns it takes. */
export function replyKey(inboxIds: string[]): string {
  const of = [...inboxIds].sort().join(",")
  return `reply:${createHash("sha256").update(of).digest("hex").slice(0, 32)}`
}

export function createAgent(options: AgentOptions): Agent {
  const { config, deps, prompt } = options
  const clock = deps.clock ?? systemClock
  const store = createStore(deps.db, config.name)

  // BUILTIN-2: the task tools exist only for an agent that declares task
  // types. Four tool schemas on every brain call is a real cost, and an
  // agent with nothing multi turn to track cannot use them anyway.
  const hasTaskTypes = Object.keys(config.taskTypes).length > 0

  // Declared here and filled in below, because the task tools need to
  // cancel pending actions and the confirmations need the tool registry.
  // One of the two has to be late, and a tool nobody has called yet is
  // the safer one.
  let taskChanged: ((task: TaskRow, why: string) => Promise<void>) | undefined
  let scheduleTaskExpiry: ((task: TaskRow) => Promise<void>) | undefined

  // First of all: everything below records events, and nothing here
  // depends on the tools, so there is no reason for it to be later.
  const events = createEvents({
    store,
    clock,
    sink: deps.events,
    onError: options.onEventError,
  })

  // LOOP-2: how this process names itself on everything it claims.
  const owner = `${config.name}:${Math.random().toString(36).slice(2, 10)}`

  const leases = createLeases({
    store,
    clock,
    owner,
    seconds: config.leaseSeconds,
  })

  const outbox = createOutbox({
    config,
    store,
    clock,
    sender: deps.sender,
    events,
    ...(options.onWorkerError !== undefined ? { onError: options.onWorkerError } : {}),
  })

  // LIMIT-1 to LIMIT-3. Above the handovers, because the summary call's
  // cost is counted here too and the spend cap opens a handover.
  const limits = createLimits({ config, store, clock })

  // HAND-1 to HAND-3. Above the tools as well, because `escalate`,
  // `take_over` and `resume` are three thin wrappers around this and
  // the rules about states and races belong in one place.
  const handovers = createHandovers({
    config,
    store,
    clock,
    events,
    outbox,
    summarise,
    scheduleWaiting: scheduleHandoverWaiting,
    scheduleIdle: scheduleHandoverIdle,
    // LIMIT-3: the summary is the one brain call outside a turn, so it is
    // the one cost nothing else would add up.
    spend: async (usd) => {
      await limits.add(usd)
    },
  })

  /**
   * HAND-6 and HAND-7: one job per moment worth looking at.
   *
   * The key carries the time, which is the trick BUILTIN-3 already uses
   * for an idle task: a job cannot be rescheduled, so every event books a
   * new one, and the ones already booked come due, find nothing to do and
   * say so. Cheap, and no two processes have to agree on a timer.
   *
   * Declared as functions rather than consts so they can be handed to
   * `createHandovers` above, which is built before the job loop.
   */
  async function scheduleHandoverWaiting(handover: { id: string }, runAt: Date): Promise<void> {
    await jobs.queue({
      kind: HANDOVER_WAITING_JOB,
      payload: { handoverId: handover.id },
      runAt,
      dedupeKey: `${HANDOVER_WAITING_JOB}:${handover.id}:${runAt.toISOString()}`,
    })
  }

  async function scheduleHandoverIdle(handover: { id: string }, runAt: Date): Promise<void> {
    await jobs.queue({
      kind: HANDOVER_IDLE_JOB,
      payload: { handoverId: handover.id },
      runAt,
      dedupeKey: `${HANDOVER_IDLE_JOB}:${handover.id}:${runAt.toISOString()}`,
    })
  }

  /**
   * HAND-2: the three lines an operator reads first.
   *
   * Writing the summary is the brain's only job in a handover, so this
   * is a plain one shot call rather than a turn: no tools, no routing,
   * no gate. It walks the brains in order like BRAIN-5 does, and gives
   * up rather than retrying, because the alert has to go out either
   * way and the person has already been told somebody will reply.
   *
   * Its cost is on the `handover_started` event. T7.3's spend cap has
   * to count it: it is the one brain call that happens outside a turn.
   */
  async function summarise(request: {
    person: PersonRow
  }): Promise<{ text: string; costUsd: number } | undefined> {
    const recent = await store.messages.list(
      { person_id: request.person.id },
      { orderBy: "seq", ascending: false, limit: SUMMARY_MESSAGES },
    )
    if (recent.length === 0) return undefined

    const transcript = [...recent]
      .reverse()
      .map((row) => `${row.author}: ${row.text}`)
      .join("\n")

    let costUsd = 0
    for (const [index, brain] of deps.brains.entries()) {
      try {
        const output = await brain.complete({
          model: models[index] ?? (models[0] as string),
          system: SUMMARY_PROMPT,
          messages: [{ role: "person", text: transcript }],
          tools: [],
        })
        costUsd += costOf(config, models[index] ?? (models[0] as string), output.usage)
        const text = output.text?.trim() ?? ""
        if (text !== "") return { text, costUsd }
      } catch {
        // The next brain, and then nothing. HAND-2 is explicit that the
        // alert does not wait on this.
      }
    }
    return undefined
  }

  const tools = createToolRegistry([
    ...(options.tools ?? []),
    // Section 10: `remember` and `forget_fact`, for every agent. Unlike
    // the task tools there is nothing to declare: every agent talks to
    // people, and a person who says they are allergic to peanuts has said
    // something worth keeping whatever the agent is for.
    ...factTools({ store, clock: deps.clock ?? systemClock }),
    // Section 10: `block`, `unblock` and `flag`. For every agent too,
    // and offered to nobody but an operator (ROLE-3). An agent with no
    // operators yet is an agent whose builder has not run
    // `openbox operator add` yet, which is not something to decide here.
    ...operatorTools({ store, events }),
    // Section 10: `escalate` for the person's side, `take_over` and
    // `resume` for the operator's. ROLE-3 keeps them apart.
    ...handoverTools({ store, handovers, clock }),
    ...(hasTaskTypes
      ? taskTools({
          config,
          store,
          clock: deps.clock ?? systemClock,
          onTaskChanged: (task, why) => taskChanged?.(task, why) ?? Promise.resolve(),
          scheduleExpiry: (task) => scheduleTaskExpiry?.(task) ?? Promise.resolve(),
        })
      : []),
  ])

  // CFG-1's last rule needs the tools, which config alone cannot see.
  const problems =
    options.tools
      ?.filter((tool) => tool.risk === "irreversible" && tool.confirmSummary === undefined)
      .map((tool) => `${tool.name} is irreversible but has no confirmSummary`) ?? []

  // CONF-3: an irreversible tool means signed Confirm and Cancel payloads,
  // which means a secret. Refused at startup rather than at the moment a
  // person is asked to confirm something, because that is the worst
  // possible time to find out.
  const irreversible = tools.all().filter((tool) => tool.risk === "irreversible")
  const secret = options.secret ?? ""
  if (irreversible.length > 0 && secret === "") {
    problems.push(
      `${irreversible.map((tool) => tool.name).join(", ")} ${
        irreversible.length === 1
          ? "is irreversible, so it needs"
          : "are irreversible, so they need"
      } OPENBOX_SECRET from the environment to sign its confirm buttons (CONF-3)`,
    )
  }

  if (problems.length > 0) {
    throw new Error(`This agent cannot start:\n${problems.map((p) => `  - ${p}`).join("\n")}`)
  }

  const models = [config.brain, ...config.brain.fallbacks].map((entry) => entry.model)

  // LEARN-2: the version is fixed the moment the agent is built, since
  // everything it covers is. The row it needs is written on the first turn,
  // and its id kept, so later turns cost no extra query.
  const hash = versionHash({ prompt, tools: tools.all(), config })
  let versionId: string | undefined

  async function version(): Promise<string> {
    if (versionId !== undefined) return versionId
    const row = await ensureVersionRow({ store, hash, clock })
    versionId = row.id
    return versionId
  }

  /**
   * ROLE-1: an unknown (channel, channel_user_id) becomes a person with
   * role end_user. Nothing in the message decides the role.
   */
  async function findOrCreatePerson(inbound: Inbound): Promise<PersonRow> {
    const existing = await store.people.find({
      channel: inbound.channel,
      channel_user_id: inbound.channelUserId,
    })
    if (existing !== null) return existing

    try {
      const created = await store.people.insert({
        channel: inbound.channel,
        channel_user_id: inbound.channelUserId,
        ...(inbound.displayName !== undefined ? { display_name: inbound.displayName } : {}),
      })
      // A free lease, so claiming them later is the one conditional update
      // DATA-4 asks for rather than an insert followed by one.
      await store.leases.insert({ person_id: created.id, expires_at: FREE }).catch(() => {})
      return created
    } catch (error) {
      // Two messages from a new person at once: one insert wins, and the
      // other reads the row the winner wrote.
      if (!isUniqueViolation(error)) throw error
      const found = await store.people.find({
        channel: inbound.channel,
        channel_user_id: inbound.channelUserId,
      })
      if (found === null) throw error
      return found
    }
  }

  /**
   * Callers of `receiveAndWait`, by the inbox row they are waiting on.
   *
   * The worker resolves these as each batch finishes. Several can wait on
   * one row, because a retried webhook is a second caller for the same
   * message.
   */
  const waiting = new Map<string, ((result: TurnResult | undefined) => void)[]>()

  /**
   * The messages this process is handling right now.
   *
   * It is what tells the watcher in `waitForHandled` apart from the real
   * case it exists for. While a message is in here, this process will
   * answer with the turn itself, so the watcher must keep its hands off
   * however finished the row looks.
   */
  const mine = new Set<string>()

  function settleWaiters(inboxIds: string[], result: TurnResult | undefined): void {
    for (const id of inboxIds) {
      for (const resolve of waiting.get(id) ?? []) resolve(result)
      waiting.delete(id)
    }
  }

  /**
   * Waits for a message to be handled.
   *
   * The local worker resolves this directly. The poll behind it is for the
   * case where another process claimed the person first: then there is no
   * `TurnResult` to hand back, only the fact that the row is finished.
   */
  async function waitForHandled(inboxId: string): Promise<TurnResult | undefined> {
    const locally = new Promise<TurnResult | undefined>((resolve) => {
      waiting.set(inboxId, [...(waiting.get(inboxId) ?? []), resolve])
    })

    const elsewhere = (async () => {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (mine.has(inboxId)) continue
        const row = await store.inbox.byId(inboxId)
        if (row === null || row.status === "done" || row.status === "failed") return undefined
      }
    })()

    return Promise.race([locally, elsewhere])
  }

  /** LOOP-2: this process, as the lease records it. */

  const jobs = createJobs({
    config,
    store,
    clock,
    events,
    owner,
    ...(options.onWorkerError !== undefined ? { onError: options.onWorkerError } : {}),
  })

  // CONF-1 to CONF-8. Built only when the agent has something to confirm,
  // so an agent with no irreversible tools carries no confirm machinery
  // and nothing can accidentally depend on it.
  const confirmations: Confirmations | undefined =
    irreversible.length === 0
      ? undefined
      : createConfirmations({
          config,
          store,
          clock,
          events,
          outbox,
          jobs,
          sender: deps.sender,
          secret,
          toolByName: (name) => tools.get(name),
          contextFor: async (person) =>
            toolContext({
              store,
              clock,
              person,
              config,
              facts: Object.fromEntries(
                (await factsFor(store, person.id)).map((fact) => [fact.key, fact.value]),
              ),
            }),
        })

  if (confirmations !== undefined) {
    jobs.on(EXPIRE_JOB, async (job) => {
      const actionId = (job.payload as { actionId?: unknown }).actionId
      if (typeof actionId === "string") await confirmations.expire(actionId)
    })
  }

  if (hasTaskTypes) {
    // CONF-6 and BUILTIN-3: a task whose fields changed, or that closed,
    // takes its pending action with it. The person agreed to what they
    // were shown, and that is no longer what they were shown.
    taskChanged = async (task, why) => {
      if (confirmations === undefined) return
      const open = await store.pendingActions.list({ task_id: task.id, status: "pending" })
      for (const action of open) {
        await store.pendingActions.update(
          { id: action.id, status: "pending" },
          { status: "cancelled", decided_at: clock.now().toISOString(), error: why },
        )
      }
    }

    // BUILTIN-3: one job per expiry time. The key carries the time, so
    // every change schedules a new one and the old ones find the task no
    // longer idle and do nothing. Rescheduling a job is not a thing the
    // dedupe key allows, and this needs no new machinery.
    scheduleTaskExpiry = async (task) => {
      await jobs.queue({
        kind: TASK_EXPIRE_JOB,
        payload: { taskId: task.id, expiresAt: task.expires_at },
        runAt: new Date(task.expires_at),
        dedupeKey: `${TASK_EXPIRE_JOB}:${task.id}:${task.expires_at}`,
      })
    }

    jobs.on(TASK_EXPIRE_JOB, async (job) => {
      const taskId = (job.payload as { taskId?: unknown }).taskId
      if (typeof taskId !== "string") return
      const task = await store.tasks.byId(taskId)
      if (task === null) return
      if (task.status !== "open" && task.status !== "active") return
      // The task was touched after this job was scheduled, so it is not
      // idle. A later job is already queued for the new time.
      if (new Date(task.expires_at).getTime() > clock.now().getTime()) return

      const [expired] = await store.tasks.update(
        { id: task.id },
        { status: "expired", closed_at: clock.now().toISOString() },
      )
      await events
        .about({ personId: task.person_id })
        .record("job_ran", { job: TASK_EXPIRE_JOB, taskId: task.id, expired: true })
      // BUILTIN-3: expiry takes the task's pending actions with it.
      if (expired !== undefined) await taskChanged?.(expired, "the task expired")
    })
  }

  // HAND-6: the handover nobody took. Ten minutes, then every hour the
  // agent is open, for as long as it stays open.
  jobs.on(HANDOVER_WAITING_JOB, async (job) => {
    const handoverId = (job.payload as { handoverId?: unknown }).handoverId
    if (typeof handoverId !== "string") return
    const what = await handovers.waitedTooLong({ handoverId })
    if (what === "nothing" || what === "gone") return
    await events.record("job_ran", { job: HANDOVER_WAITING_JOB, handoverId, did: what })
  })

  // HAND-7: the handover with nothing said in it. The person goes back to
  // the agent rather than being left with nobody.
  jobs.on(HANDOVER_IDLE_JOB, async (job) => {
    const handoverId = (job.payload as { handoverId?: unknown }).handoverId
    if (typeof handoverId !== "string") return
    const what = await handovers.endIfIdle({ handoverId })
    if (what === "nothing") return
    await events.record("job_ran", { job: HANDOVER_IDLE_JOB, handoverId, did: what })
  })

  // PRO-1 and PRO-2: the agent speaking first. The rules about what is
  // sent, and to whom nothing is sent, live in proactive.ts; the turn a
  // composed message needs lives here, because a turn needs the lease,
  // the version row and everything else `createAgent` holds.
  const proactive = createProactive({
    config,
    store,
    clock,
    events,
    outbox,
    jobs,
    compose: composeProactive,
    handoverFor: (person) => handovers.openFor(person),
  })

  jobs.on(PROACTIVE_JOB, async (job) => {
    // The handler's own record says what it did and why, so the loop's
    // `job_ran` is left to say whether it threw.
    await proactive.run(job)
  })

  /**
   * CONF-2 and CONF-8: what the brain is told about a confirmation the core
   * already resolved.
   *
   * Written as an instruction rather than a fact, because the brain's job
   * here is to say the right thing to the person and the one mistake that
   * matters is telling them something happened when it did not.
   */
  function noticeFor(resolution: Resolution): string {
    const tool = resolution.action?.tool ?? "the action"
    switch (resolution.kind) {
      case "executed":
        return `The person confirmed ${tool} and it has been done. Tell them it is done. Do not offer to do it again.`
      case "failed":
        return `The person confirmed ${tool} but it failed: ${resolution.error}. It did not happen. Tell them it did not go through. Do not say it is done.`
      case "cancelled":
        return `The person cancelled ${tool}. Nothing was done. Acknowledge it and ask what they would like instead.`
      case "already_done":
        return `${tool} had already gone through, so nothing changed. Tell them it already went through.`
      case "rejected":
        return resolution.why === "expired"
          ? `The person's confirmation for ${tool} arrived too late and was not accepted. Nothing was done. Tell them the request expired and offer to set it up again.`
          : `The person's confirmation for ${tool} was not accepted, because it does not match the request. Nothing was done. Tell them it does not match and offer to set it up again.`
    }
  }

  const worker = createWorker({
    config,
    store,
    leases,
    clock,
    events,
    runTurn: runOneTurn,
    ...(options.onWorkerError !== undefined ? { onError: options.onWorkerError } : {}),
  })

  /**
   * LOOP-1: writes the message down. The person and the inbox row are the
   * only things a caller waits for.
   */
  async function write(inbound: Inbound): Promise<ReceiveResult> {
    const person = await findOrCreatePerson(inbound)
    const receivedAt = inbound.receivedAt ?? clock.now()

    // The same channel message id twice is a duplicate, and the unique
    // constraint is what decides, not a prior read. Two deliveries at once
    // therefore cannot both become work.
    try {
      const row = await store.inbox.insert({
        person_id: person.id,
        channel_message_id: inbound.channelMessageId,
        ...(inbound.text !== undefined ? { text: inbound.text } : {}),
        ...(inbound.media !== undefined ? { media: inbound.media } : {}),
        ...(inbound.action !== undefined ? { action: inbound.action } : {}),
        received_at: receivedAt.toISOString(),
      })
      // The worker looks now rather than on its next poll, so this
      // process answers as fast as it did when the turn ran inline.
      worker.nudge()
      return { inboxId: row.id, duplicate: false }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      const existing = await store.inbox.find({
        person_id: person.id,
        channel_message_id: inbound.channelMessageId,
      })
      await events.about({ personId: person.id }).record("duplicate_dropped", {
        channel: inbound.channel,
        channelMessageId: inbound.channelMessageId,
        inboxId: existing?.id ?? null,
      })
      return { inboxId: existing?.id ?? "", duplicate: true }
    }
  }

  /** Messages queued that the outbox could send right now. */
  async function dueCount(): Promise<number> {
    const rows = await store.outbox.list({ status: "queued" }, { orderBy: "seq", limit: 200 })
    const now = clock.now().getTime()
    return rows.filter((row) => new Date(row.not_before).getTime() <= now).length
  }

  /** Rows waiting that a turn could take right now (LOOP-3). */
  async function readyCount(): Promise<number> {
    const rows = await store.inbox.list({ status: "pending" }, { orderBy: "seq", limit: 200 })
    const cutoff = clock.now().getTime() - config.burstWindowMs
    return rows.filter((row) => new Date(row.received_at).getTime() <= cutoff).length
  }

  return {
    config,
    store,
    tools,
    events,
    versionHash: hash,
    owner,
    outbox,
    jobs,
    confirmations,
    handovers,
    limits,

    receive: write,

    async receiveAndWait(inbound: Inbound): Promise<ReceiveAndWaitResult> {
      if (!worker.running) {
        throw new Error(
          "receiveAndWait needs this process to be handling turns. Call agent.start() first, or use receive() if another process runs the worker.",
        )
      }

      const { inboxId, duplicate } = await write(inbound)
      if (inboxId === "") return { inboxId, duplicate }

      const turn = await waitForHandled(inboxId)

      // API-2: not resolved until everything the turn sent has reached a
      // final state. Waiting here rather than inside the turn keeps a
      // person's slot free: a channel that is refusing for thirty seconds
      // would otherwise hold the worker, and `stop()` behind it. Order is
      // not at risk, because the outbox sends one person's messages one at
      // a time in the order they were queued.
      if (turn?.turnId !== undefined) await outbox.settle(turn.turnId)

      return { inboxId, duplicate, ...(turn !== undefined ? { turn } : {}) }
    },

    schedule: (request) => proactive.schedule(request),

    trigger: (request) => proactive.trigger(request),

    start(): void {
      worker.start()
      outbox.pump.start()
      jobs.pump.start()
    },

    async stop(): Promise<void> {
      // The outbox stops last, so a reply a turn just decided on still
      // goes out rather than being left queued.
      await jobs.pump.stop()
      await worker.stop()
      await outbox.pump.stop()
    },

    inFlight: () => worker.busy(),

    async settled(): Promise<void> {
      // Not just "no turn running": a message nudged a moment ago may not
      // have been claimed yet. This waits until there is nothing running
      // and nothing left that a turn could take.
      for (;;) {
        await worker.drain()
        await outbox.pump.drain()
        await jobs.pump.drain()
        const ready = await readyCount()
        const due = await dueCount()
        // The counts first, then what is in flight, and never the other
        // way round. A pass that started while those two reads were in
        // the air has already claimed its rows, so the counts can be zero
        // while a message is on its way out. `sweeping()` is the half of
        // that which `busy()` cannot see (Known K14).
        const quiet =
          ready === 0 &&
          due === 0 &&
          !worker.sweeping() &&
          !outbox.pump.sweeping() &&
          !jobs.pump.sweeping() &&
          worker.busy() === 0 &&
          outbox.pump.busy() === 0 &&
          jobs.pump.busy() === 0
        if (quiet) return
        worker.nudge()
        outbox.pump.nudge()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }

  /**
   * One turn over one person's waiting messages, which never rejects.
   *
   * Nothing awaits this but the worker, so a throw here would be an
   * unhandled rejection rather than a visible error. A failure becomes a
   * `failed` outcome instead: recorded on the turn, on the inbox rows and
   * in the trace, handed to `onTurnError`, and handed back to anyone
   * waiting in `receiveAndWait`.
   */
  async function runOneTurn(person: PersonRow, batch: InboxRow[]): Promise<TurnResult> {
    const startedAt = clock.now()
    const where: { turnId?: string | undefined } = {}
    const inboxIds = batch.map((row) => row.id)
    for (const id of inboxIds) mine.add(id)

    try {
      let result: TurnResult
      let handled: "done" | "failed" = "done"
      try {
        result = await attemptTurn(person, batch, startedAt, where)
        // A turn can end without anyone being answered and without
        // throwing. BRAIN-5 running out of brains is one way, and the step
        // cap is the other. Both leave a person waiting, so both leave the
        // row findable rather than marked done.
        //
        // LOOP-12 and LOOP-9 both say these should also send a holding
        // message and alert an operator. That is T7.3. Until then the
        // status is the only thing that says nobody was answered.
        if (UNANSWERED.has(result.outcome)) handled = "failed"
      } catch (error) {
        handled = "failed"
        result = await turnFailed({ person, batch, turnId: where.turnId, startedAt, error })
      }

      try {
        // Marked before anyone waiting is answered, so a caller that goes
        // straight on to read the row sees what happened to it. Not `done`
        // on a failure: a message that was never answered has to stay
        // findable.
        await store.inbox.update(
          { person_id: person.id },
          { status: handled, ...(where.turnId !== undefined ? { turn_id: where.turnId } : {}) },
          { isIn: { id: inboxIds } },
        )
      } catch {
        // Best effort, like everything else on the failure path.
      }

      settleWaiters(inboxIds, result)
      return result
    } finally {
      for (const id of inboxIds) mine.delete(id)
    }
  }

  async function attemptTurn(
    person: PersonRow,
    batch: InboxRow[],
    startedAt: Date,
    where: { turnId?: string | undefined },
  ): Promise<TurnResult> {
    const versionRowId = await version()
    const turnRow = await store.turns.insert({
      person_id: person.id,
      // LEARN-2: every turn stores the version it ran under.
      version_id: versionRowId,
      started_at: startedAt.toISOString(),
    })
    where.turnId = turnRow.id
    const inboxIds = batch.map((row) => row.id)

    // LOOP-3: exactly the rows this turn took, and no others. A row that
    // arrived a moment ago is still `pending`, so it waits for the next
    // turn (LOOP-4) instead of being swallowed without the brain seeing it.
    await store.inbox.update(
      { person_id: person.id },
      { status: "merged", turn_id: turnRow.id },
      { isIn: { id: inboxIds } },
    )

    const turnEvents = events.about({ personId: person.id, turnId: turnRow.id })
    await turnEvents.record("turn_started", {
      channel: person.channel,
      inboxIds,
      messages: batch.length,
      versionId: versionRowId,
      hasMedia: batch.some((row) => row.media !== null),
      hasAction: batch.some((row) => row.action !== null),
    })

    // LOOP-7 wants the history *then* the current batch, so history is read
    // before these messages join it. Otherwise the brain sees them twice.
    const history = (await store.messages.list(
      { person_id: person.id },
      // By insert order, so a reply can never sort before its question.
      { orderBy: "seq", ascending: false, limit: config.history },
    )) as MessageRow[]

    await store.messages.insertMany(
      batch.map((row) => ({
        person_id: person.id,
        turn_id: turnRow.id,
        direction: "inbound",
        author: "person",
        text: row.text ?? "",
        channel: person.channel,
        created_at: row.received_at,
      })),
    )

    // LOOP-5 step 1, ROLE-4: a blocked person's messages are stored and
    // get no reply. Stored is the half worth saying out loud: the rows
    // written just above are the record, and an operator may want to
    // read them.
    //
    // First, because LOOP-5 says the first check that applies decides
    // the turn. So a pending action cannot be confirmed by someone who
    // has since been blocked, and a blocked person costs no brain call,
    // no decision request and no context reads at all.
    if (person.blocked) {
      return finish(nothingHappened("blocked"), turnRow, turnEvents, startedAt, batch.length)
    }

    // LOOP-5 step 2: STOP and START. Before the handover check, because
    // LOOP-5's order says so and because the one message a person must
    // always be able to send is the one that makes us stop. It costs no
    // brain call and no decision request: the whole turn is a column on
    // the person and one fixed line back.
    //
    // The last of them decides, so STOP then START in one burst leaves
    // them opted in, which is the order they said it in.
    const words = batch.map((row) => optOutWord(row.text)).filter((word) => word !== undefined)
    const word = words[words.length - 1]
    if (word !== undefined) {
      const out = word === "stop"
      await store.people.update({ id: person.id }, { opted_out: out })
      const text = out ? OPTED_OUT_REPLY : OPTED_IN_REPLY
      // A reply, not a proactive message, so PRO-3 lets it out: the
      // confirmation that they will hear nothing more has to be the one
      // thing that still reaches them.
      await deliver({
        person,
        turnId: turnRow.id,
        text,
        key: replyKey(inboxIds),
        kind: "reply",
      })
      return finish(
        { ...nothingHappened(out ? "opted_out" : "opted_in"), reply: text },
        turnRow,
        turnEvents,
        startedAt,
        batch.length,
      )
    }

    // LOOP-5 step 3, LIMIT-1: the rate limit. Before the handover check
    // and before anything is spent, because a flood has to be cheap: no
    // brain call, no decision request, no context reads.
    //
    // Not applied to an operator. The control channel is how a colleague
    // says `resume`, and twenty messages in ten minutes is a normal
    // afternoon for somebody relaying.
    if (person.role === "end_user") {
      const standing = await limits.rate(person)
      if (standing !== "under") {
        if (standing === "over") {
          // Recorded before the reply, because this is what the next
          // turn in this window reads to stay silent. A crash between
          // the two costs the person a courtesy; the other order would
          // cost them the rule.
          await turnEvents.record("limit_hit", {
            limit: "rate",
            messagesPerWindow: config.limits.messagesPerWindow,
            windowMinutes: config.limits.windowMinutes,
          })
          await deliver({
            person,
            turnId: turnRow.id,
            text: RATE_LIMIT_REPLY,
            key: replyKey(inboxIds),
            kind: "reply",
          })
          // LIMIT-1: and an operator alert. Not a handover: nobody
          // should be handed a conversation with somebody flooding
          // them, and there is no reason in HAND-1 for one.
          await handovers.tellOperators({
            text: `${nameOf(person)} has gone over the rate limit, so they have had one fixed reply and will get silence until the window passes.`,
            // One alert per person per window, whatever arrives next.
            key: `rate:${person.id}:${Math.floor(clock.now().getTime() / (config.limits.windowMinutes * 60_000))}`,
            urgent: false,
          })
        }
        return finish(nothingHappened("rate_limited"), turnRow, turnEvents, startedAt, batch.length)
      }
    }

    // LOOP-5 step 4, LIMIT-3: the spend cap. Every new turn becomes a
    // handover trigger until midnight in the agent's timezone.
    //
    // Checked here, before the brain, because a cap that is read after
    // the spending is a cap that does nothing. Operators are alerted by
    // the handover, and the person is told by it.
    if (person.role === "end_user") {
      const spend = await limits.spent()
      if (spend.over) {
        await turnEvents.record("limit_hit", {
          limit: "spend",
          usd: spend.usd,
          capUsd: config.limits.dailySpendUsd,
        })
        await handovers.open({
          person,
          reason: "spend_cap",
          detail: `spent ${spend.usd.toFixed(4)} of ${config.limits.dailySpendUsd} today`,
          turnId: turnRow.id,
          // The one handover opened without HAND-2's three lines: the
          // summary is a brain call, and this is the moment the agent
          // must stop spending.
          summarise: false,
        })
        return finish(nothingHappened("handover"), turnRow, turnEvents, startedAt, batch.length)
      }
    }

    // One Relayed per message, whichever direction this turn is. The
    // inbox row id is what keys the send, so a turn that runs twice
    // does not send the same words twice.
    const items = batch.map((row) => ({ id: row.id, text: row.text ?? "" }))

    // LOOP-5 step 5: a person in a handover belongs to a colleague, so
    // the agent does not answer them. Their messages are stored, and
    // HAND-5 forwards them to whoever is on it.
    //
    // Not applied to an operator. Their messages are the control
    // channel: an operator who could be silenced by a row of their own
    // would have no way left to say `resume`.
    if (person.role === "end_user") {
      const theirs = await handovers.openFor(person)
      if (theirs !== undefined) {
        await handovers.forward({ handover: theirs, person, items, turnId: turnRow.id })
        return finish(nothingHappened("handover"), turnRow, turnEvents, startedAt, batch.length)
      }
    }

    // HAND-4: while an operator's focus is on an active handover, what
    // they type belongs to the person in it, word for word, with no
    // brain and no routing. A slash is how they reach the agent
    // instead, and it is the only way out of the relay, so it is read
    // per message rather than per turn: three sentences and one
    // command in a burst are four things with two destinations.
    const focus = person.role === "operator" ? await handovers.focusOf(person) : undefined
    let forBrain = batch
    if (focus !== undefined) {
      const words = items.filter((item) => !isCommand(item.text))
      if (words.length > 0) {
        await handovers.relay({ handover: focus, items: words, turnId: turnRow.id })
      }
      forBrain = batch.filter((row) => isCommand(row.text ?? ""))
      // Nothing was addressed to the agent, so there is no turn to
      // run: no brain call, no decision request, nothing spent. An
      // operator typing to a customer should cost what typing costs.
      if (forBrain.length === 0) {
        return finish(nothingHappened("relayed"), turnRow, turnEvents, startedAt, batch.length)
      }
    }

    // HAND-4: the slash is addressing, not content, so the brain reads
    // the sentence without it.
    const texts = forBrain.map((row) =>
      focus === undefined ? (row.text ?? "") : asCommand(row.text ?? ""),
    )

    // HAND-4: who this operator is replying to, for the runtime block.
    // Read here rather than in `runTurn`, which knows nothing about
    // handovers and should not start now.
    const focused = focus === undefined ? null : await store.people.byId(focus.person_id)

    // CONF-4 and CONF-8: a confirmation is not a message for the brain.
    // It is resolved here, before the brain is asked anything, and what
    // happened goes into the conversation as a notice so the brain can
    // tell the person. Resolving it in the turn rather than in `receive`
    // is deliberate: the person lease is held here, so two taps arriving
    // at once are already serialised by the time they reach this.
    const notices: string[] = []
    if (confirmations !== undefined) {
      // HAND-4: only what was addressed to the agent. A sentence an
      // operator relayed to a customer is not an answer to a question the
      // agent asked them, even if it happens to read like one.
      for (const [index, row] of forBrain.entries()) {
        const tapped = row.action as { payload?: unknown } | null
        const resolution = await confirmations.resolve({
          person,
          ...(row.text !== null ? { text: texts[index] ?? row.text } : {}),
          ...(typeof tapped?.payload === "string" ? { payload: tapped.payload } : {}),
        })
        if (resolution === null) continue

        const notice = noticeFor(resolution)
        notices.push(notice)
        // Stored too, so the next turn's history carries it and the brain
        // cannot claim later that nothing happened.
        await store.messages.insert({
          person_id: person.id,
          turn_id: turnRow.id,
          direction: "inbound",
          author: "notice",
          text: notice,
          channel: person.channel,
        })
      }
    }

    // LOOP-7: read before the turn, so the brain sees where the
    // conversation got to rather than having to work it out from thirty
    // messages. BUILTIN-2's `missing` is the part it must not work out.
    const facts = await factsFor(store, person.id)
    const tasks = hasTaskTypes ? await openTasks(store, person) : []
    const active = tasks.find((task) => task.status === "active")
    const pending =
      confirmations === undefined
        ? []
        : await store.pendingActions.list({ person_id: person.id, status: "pending" })

    const result = await runTurn({
      config,
      history: [...history].reverse(),
      store,
      brains: deps.brains,
      decisionModel: deps.decisionModel,
      models,
      tools,
      clock,
      person,
      // LOOP-3: the whole burst, in arrival order.
      batch: texts,
      prompt,
      turnId: turnRow.id,
      events: turnEvents,
      ...(notices.length > 0 ? { notices } : {}),
      ...(confirmations !== undefined ? { confirm: confirmations } : {}),
      ...(facts.length > 0 ? { facts } : {}),
      ...(tasks.length > 0 ? { tasks } : {}),
      ...(pending.length > 0 ? { pendingActions: pending } : {}),
      ...(focused !== null ? { focus: { who: nameOf(focused) } } : {}),
      ...(active !== undefined
        ? {
            activeTask: {
              id: active.id,
              type: active.type,
              fields: active.fields,
              missing: active.missing,
            },
          }
        : {}),
    })

    if (result.reply !== undefined) {
      // Keyed by the messages being answered, not by the turn.
      //
      // A turn abandoned by a dying process has its messages handed back
      // by the recovery sweep, and the turn that then answers them is a
      // different turn. Keyed by turn id, both replies would go out and
      // the person would be answered twice. Keyed by what is being
      // answered, the outbox keeps the first and drops the second, which
      // is the right number of answers to one question.
      await deliver({
        person,
        turnId: turnRow.id,
        text: result.reply,
        key: replyKey(inboxIds),
        kind: "reply",
      })
    }

    // LOOP-9 and LOOP-12: the two ways a turn ends with nobody answered.
    // The person gets a fixed line, the turn is flagged, and a colleague
    // is told, which is a handover: both of those lines are a promise
    // that somebody will come back, and a handover is what gives a
    // promise an owner and HAND-6's clock.
    if (
      result.reply === undefined &&
      (result.outcome === "step_cap" || result.outcome === "brains_failed")
    ) {
      const capped = result.outcome === "step_cap"
      await deliver({
        person,
        turnId: turnRow.id,
        text: capped ? STEP_CAP_REPLY : BRAINS_FAILED_REPLY,
        key: replyKey(inboxIds),
        kind: "reply",
      })
      // LEARN-1: LOOP-9 fired. The handover raises its own flag, so
      // this is the one the step cap adds.
      if (capped) {
        await turnEvents.flag("step_cap", { steps: result.steps, maxSteps: config.maxSteps })
      }
      await handovers.open({
        person,
        reason: capped ? "step_cap" : "brains_failed",
        turnId: turnRow.id,
        // Every brain is down, so there is nothing to write the three
        // lines with. The alert says to read the conversation.
        ...(capped ? {} : { summarise: false }),
      })
    }

    // HAND-1: the triggers this turn noticed, in the order it noticed
    // them. The first one is the reason recorded; a second trigger in
    // the same turn is the same handover, which the unique index
    // decides rather than this code.
    //
    // After the reply, not instead of it. The brain was told what
    // happened and may well have said something sensible, and the
    // person should hear that before being told a colleague is coming.
    const trigger = result.handoverDue[0]
    if (trigger !== undefined) {
      await handovers.open({ person, reason: trigger, turnId: turnRow.id })
    }

    return finish(result, turnRow, turnEvents, startedAt, batch.length)
  }

  /** Told when something outside a turn went wrong, if anyone is listening. */
  function reportWorker(error: unknown): void {
    try {
      options.onWorkerError?.(error)
    } catch {
      // A broken handler must not be the reason a lease is not given up.
    }
  }

  /**
   * PRO-2: one turn with nobody on the other side of it.
   *
   * The same brain, the same tools, the same routing and the same gate as
   * any other turn. What differs is the input: there is no batch, and the
   * note about the event goes in where a confirmation's notice would, so
   * the brain reads what happened rather than a message nobody sent.
   *
   * It throws for the two cases the job loop should try again: the person
   * is busy, and the turn ended without anything to say because the
   * brains were down (JOB-2).
   */
  async function composeProactive(request: {
    person: PersonRow
    note: string
    key: string
    urgent: boolean
  }): Promise<"composed" | "silent"> {
    const { person } = request
    const startedAt = clock.now()

    // LOOP-2: one person is one turn at a time, here as well as in the
    // worker. A person in the middle of a conversation is left alone and
    // the job comes back in a moment, because a message written beside a
    // live turn would talk over whatever that turn is saying.
    const lease = await leases.claim(person.id)
    if (lease === null) {
      throw new Error(`${nameOf(person)} is being handled right now, so this message waits`)
    }

    const renewal = setInterval(
      () => {
        leases.renew(person.id).then(
          (kept) => {
            if (!kept) {
              reportWorker(new Error(`the lease on person ${person.id} was lost mid turn`))
            }
          },
          (error: unknown) => reportWorker(error),
        )
      },
      Math.max(1_000, (config.leaseSeconds * 1000) / 3),
    )

    const where: { turnId?: string | undefined } = {}
    let ended: { did: "composed" | "silent" } | { retry: string }
    try {
      ended = await proactiveTurn({ ...request, startedAt, where })
    } catch (error) {
      await turnFailed({ person, batch: [], turnId: where.turnId, startedAt, error })
      // Thrown on, so the job records it and tries again (JOB-2).
      throw error
    } finally {
      clearInterval(renewal)
      await leases.release(person.id).catch(reportWorker)
    }

    // The lease is already given up here, which is the point: the next
    // attempt is a fresh turn and must not meet a lease this one held.
    if ("retry" in ended) throw new Error(ended.retry)
    return ended.did
  }

  /** The turn `composeProactive` holds the lease for. */
  async function proactiveTurn(request: {
    person: PersonRow
    note: string
    key: string
    urgent: boolean
    startedAt: Date
    where: { turnId?: string | undefined }
  }): Promise<{ did: "composed" | "silent" } | { retry: string }> {
    const { person, note, startedAt } = request
    const versionRowId = await version()
    const turnRow = await store.turns.insert({
      person_id: person.id,
      version_id: versionRowId,
      started_at: startedAt.toISOString(),
    })
    request.where.turnId = turnRow.id

    const turnEvents = events.about({ personId: person.id, turnId: turnRow.id })
    await turnEvents.record("turn_started", {
      channel: person.channel,
      inboxIds: [],
      messages: 0,
      versionId: versionRowId,
      hasMedia: false,
      hasAction: false,
      // What tells this turn apart in the trace: nobody wrote to us.
      proactive: true,
    })

    const history = (await store.messages.list(
      { person_id: person.id },
      { orderBy: "seq", ascending: false, limit: config.history },
    )) as MessageRow[]

    // The note joins the conversation, the way a confirmation's notice
    // does, so the next turn's history says why the agent spoke first.
    await store.messages.insert({
      person_id: person.id,
      turn_id: turnRow.id,
      direction: "inbound",
      author: "notice",
      text: note,
      channel: person.channel,
      created_at: clock.now().toISOString(),
    })

    const facts = await factsFor(store, person.id)
    const tasks = hasTaskTypes ? await openTasks(store, person) : []
    const active = tasks.find((task) => task.status === "active")
    const pending =
      confirmations === undefined
        ? []
        : await store.pendingActions.list({ person_id: person.id, status: "pending" })

    const result = await runTurn({
      config,
      history: [...history].reverse(),
      store,
      brains: deps.brains,
      decisionModel: deps.decisionModel,
      models,
      tools,
      clock,
      person,
      // Nobody said anything. The note is the whole input.
      batch: [],
      prompt,
      turnId: turnRow.id,
      events: turnEvents,
      notices: [note],
      proactive: true,
      ...(confirmations !== undefined ? { confirm: confirmations } : {}),
      ...(facts.length > 0 ? { facts } : {}),
      ...(tasks.length > 0 ? { tasks } : {}),
      ...(pending.length > 0 ? { pendingActions: pending } : {}),
      ...(active !== undefined
        ? {
            activeTask: {
              id: active.id,
              type: active.type,
              fields: active.fields,
              missing: active.missing,
            },
          }
        : {}),
    })

    if (result.reply !== undefined) {
      await deliver({
        person,
        turnId: turnRow.id,
        text: result.reply,
        key: request.key,
        kind: "proactive",
        urgent: request.urgent,
      })
    }

    // HAND-1: a composed turn can trigger a handover like any other. The
    // repeat rules and a tool failing twice both count across turns, and
    // a turn nobody asked for is still a turn that went wrong.
    const trigger = result.handoverDue[0]
    if (trigger !== undefined) {
      await handovers.open({ person, reason: trigger, turnId: turnRow.id })
    }

    await finish(result, turnRow, turnEvents, startedAt, 0)

    // BRAIN-5 ran out of brains, or the step cap stopped it. Nobody has
    // heard anything, so the job tries again rather than calling this done.
    if (UNANSWERED.has(result.outcome)) {
      return { retry: `the message could not be written: the turn ended ${result.outcome}` }
    }
    // The brain was asked and had nothing to add, which is an answer.
    return { did: result.reply === undefined ? "silent" : "composed" }
  }

  /** LOOP-11 and EVT-2: what every turn records on the way out. */
  async function finish(
    result: TurnResult,
    turnRow: { id: string },
    turnEvents: EventWriter,
    startedAt: Date,
    messages: number,
  ): Promise<TurnResult> {
    const latencyMs = clock.now().getTime() - startedAt.getTime()

    // LIMIT-3: what this turn cost joins today's total, before anything
    // else is written, so a turn that spent money is counted even if the
    // records below fail. A turn that spent nothing costs no write.
    if (result.costUsd > 0 && (await limits.add(result.costUsd)) === null) {
      reportWorker(
        new Error(
          `today's spend total would not take ${result.costUsd} from turn ${turnRow.id}, so the cap is now reading low`,
        ),
      )
    }
    await store.turns.update(
      { id: turnRow.id },
      {
        brains: result.brainsUsed,
        steps: result.steps,
        cost_usd: result.costUsd,
        latency_ms: latencyMs,
        outcome: result.outcome,
        ended_at: clock.now().toISOString(),
      },
    )
    await turnEvents.record("turn_ended", {
      outcome: result.outcome,
      steps: result.steps,
      costUsd: result.costUsd,
      latencyMs,
      brains: result.brainsUsed,
      replied: result.reply !== undefined,
      toolsRun: result.toolsRun.length,
      messages,
    })

    return { ...result, turnId: turnRow.id }
  }

  /**
   * Records a turn that failed, as far as the database still lets us.
   *
   * Every write here is best effort: whatever broke the turn may well be
   * the database itself, and this must still return a result for the
   * worker and for anyone waiting.
   */
  async function turnFailed(failure: {
    person: PersonRow
    batch: InboxRow[]
    turnId: string | undefined
    startedAt: Date
    error: unknown
  }): Promise<TurnResult> {
    const { person, batch, turnId, startedAt, error } = failure
    const message = error instanceof Error ? error.message : String(error)
    const latencyMs = clock.now().getTime() - startedAt.getTime()
    const inboxIds = batch.map((row) => row.id)

    try {
      options.onTurnError?.({ inboxIds, personId: person.id, turnId, error })
    } catch {
      // A broken handler is not worth losing the rest of the record over.
    }

    try {
      if (turnId !== undefined) {
        await store.turns.update(
          { id: turnId },
          { outcome: "failed", latency_ms: latencyMs, ended_at: clock.now().toISOString() },
        )
      }
    } catch {
      // Nothing left to do about it here.
    }

    await events
      .about({ personId: person.id, ...(turnId !== undefined ? { turnId } : {}) })
      .record("turn_ended", { outcome: "failed", latencyMs, replied: false, error: message })

    return {
      ...(turnId !== undefined ? { turnId } : {}),
      steps: 0,
      costUsd: 0,
      brainsUsed: [],
      routed: [],
      handoverDue: [],
      droppedCalls: [],
      toolsRun: [],
      outcome: "failed",
      error: message,
    }
  }

  /**
   * LOOP-11: what the turn decided goes to the outbox, and is stored
   * either way.
   *
   * The key is the caller's, because what makes two sends the same
   * message depends on why it was sent. A reply is keyed by the messages
   * it answers (see `replyKey`), and a proactive message by the job that
   * asked for it (PRO-1).
   */
  async function deliver(request: {
    person: PersonRow
    turnId: string
    text: string
    key: string
    kind: "reply" | "proactive"
    urgent?: boolean | undefined
  }): Promise<void> {
    const { person, turnId, text } = request
    await outbox.queue({
      personId: person.id,
      turnId,
      kind: request.kind,
      channel: person.channel,
      channelUserId: person.channel_user_id,
      text,
      idempotencyKey: request.key,
      ...(request.urgent === true ? { urgent: true } : {}),
    })

    await store.messages.insert({
      person_id: person.id,
      turn_id: turnId,
      direction: "outbound",
      author: "agent",
      text,
      channel: person.channel,
      // TIME-1: the injected clock, not the database's now().
      created_at: clock.now().toISOString(),
    })
  }
}
