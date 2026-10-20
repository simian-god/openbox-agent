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
import type { Clock } from "../testing/clock.ts"
import { systemClock } from "../testing/clock.ts"
import { createEvents, type EventFailure, type EventSink, type EventWriter } from "./events.ts"
import { createLeases, FREE } from "./lease.ts"
import { createOutbox, type Outbox } from "./outbox.ts"
import { createWorker } from "./worker.ts"
import type { Inbound, Sender } from "./sender.ts"
import { runTurn, type TurnResult } from "./turn.ts"
import { ensureVersionRow, versionHash } from "./version.ts"

export interface Deps {
  /** The first is the primary, the rest are fallbacks in order. */
  brains: Brain[]
  db: SupabaseClient
  sender: Sender
  clock?: Clock | undefined
  /** EVT-1: told about every event, alongside the agent's own table. */
  events?: EventSink | undefined
  // decisionModel, transcriber and retriever join Deps as the features
  // that need them land, in M3, M7 and M8. They are left out rather than
  // stubbed, so nothing can quietly depend on a fake.
}

export interface AgentOptions {
  config: OpenboxConfig
  deps: Deps
  /** The static system prompt, prompt.md in a real agent (SKILL-8). */
  prompt: string
  tools?: Tool[]
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
  /** API-1: writes the message down and returns. The turn runs behind it. */
  receive(inbound: Inbound): Promise<ReceiveResult>
  /**
   * API-2: the same, then waits until the message has been handled.
   *
   * Needs this process to be running the worker, so `start()` comes first.
   * A webhook that only hands messages over uses `receive`.
   */
  receiveAndWait(inbound: Inbound): Promise<ReceiveAndWaitResult>
  /** Starts the worker (LOOP-2). Nothing is handled here until it runs. */
  start(): void
  /** Stops it, finishing the turns in flight and giving up every lease. */
  stop(): Promise<void>
  /** How many turns are running right now. */
  inFlight(): number
  /** Resolves once no turn is running. `stop()` in T2.2 builds on this. */
  settled(): Promise<void>
}

export function createAgent(options: AgentOptions): Agent {
  const { config, deps, prompt } = options
  const clock = deps.clock ?? systemClock
  const store = createStore(deps.db, config.name)
  const tools = createToolRegistry(options.tools ?? [])
  const events = createEvents({
    store,
    clock,
    sink: deps.events,
    onError: options.onEventError,
  })

  // CFG-1's last rule needs the tools, which config alone cannot see.
  const problems = options.tools
    ?.filter((tool) => tool.risk === "irreversible" && tool.confirmSummary === undefined)
    .map((tool) => `${tool.name} is irreversible but has no confirmSummary`)
  if (problems !== undefined && problems.length > 0) {
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

    start(): void {
      worker.start()
      outbox.pump.start()
    },

    async stop(): Promise<void> {
      // The outbox stops last, so a reply a turn just decided on still
      // goes out rather than being left queued.
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
        const quiet =
          worker.busy() === 0 &&
          outbox.pump.busy() === 0 &&
          (await readyCount()) === 0 &&
          (await dueCount()) === 0
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

    const texts = batch.map((row) => row.text ?? "")
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

    const result = await runTurn({
      config,
      history: [...history].reverse(),
      store,
      brains: deps.brains,
      models,
      tools,
      clock,
      person,
      // LOOP-3: the whole burst, in arrival order.
      batch: texts,
      prompt,
      turnId: turnRow.id,
      events: turnEvents,
    })

    if (result.reply !== undefined) {
      await deliver(person, turnRow.id, result.reply)
    }

    // LOOP-11: the turn records what it did.
    const latencyMs = clock.now().getTime() - startedAt.getTime()
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
      messages: batch.length,
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
      toolsRun: [],
      outcome: "failed",
      error: message,
    }
  }

  /** LOOP-11: the reply goes to the outbox, and is stored either way. */
  async function deliver(person: PersonRow, turnId: string, text: string): Promise<void> {
    await outbox.queue({
      personId: person.id,
      turnId,
      kind: "reply",
      channel: person.channel,
      channelUserId: person.channel_user_id,
      text,
      // The same turn can only ever produce one reply, so this key makes
      // a retried turn harmless.
      idempotencyKey: `${turnId}:reply`,
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
