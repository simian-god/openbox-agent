// createAgent and receive (Spec section 3).
//
// Turn v0 runs the turn inside `receive`. T2.1 and T2.2 split that into an
// inbox and a worker, where `receive` returns at once (API-1) and the turn
// happens behind it. The shape here is chosen so that split does not
// change what a caller sees.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { OpenboxConfig } from "../config/index.ts"
import type { Brain } from "../providers/brains/types.ts"
import {
  createStore,
  isUniqueViolation,
  type MessageRow,
  type PersonRow,
  type Store,
} from "../store/index.ts"
import { createToolRegistry, type Tool, type ToolRegistry } from "../tools/index.ts"
import type { Clock } from "../testing/clock.ts"
import { systemClock } from "../testing/clock.ts"
import { createEvents, type EventFailure, type EventSink, type EventWriter } from "./events.ts"
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
}

export interface ReceiveResult {
  inboxId: string
  duplicate: boolean
  /** Absent when the message was a duplicate, so no turn ran. */
  turn?: TurnResult | undefined
}

export interface Agent {
  readonly config: OpenboxConfig
  readonly store: Store
  readonly tools: ToolRegistry
  readonly events: EventWriter
  /** LEARN-2: the hash of the prompt, tools, config and core version. */
  readonly versionHash: string
  receive(inbound: Inbound): Promise<ReceiveResult>
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
      return await store.people.insert({
        channel: inbound.channel,
        channel_user_id: inbound.channelUserId,
        ...(inbound.displayName !== undefined ? { display_name: inbound.displayName } : {}),
      })
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

  return {
    config,
    store,
    tools,
    events,
    versionHash: hash,

    async receive(inbound: Inbound): Promise<ReceiveResult> {
      const person = await findOrCreatePerson(inbound)
      const receivedAt = inbound.receivedAt ?? clock.now()

      // LOOP-1: the same channel message id twice is a duplicate, and
      // the unique constraint is what decides, not a prior read.
      let inboxId: string
      try {
        const row = await store.inbox.insert({
          person_id: person.id,
          channel_message_id: inbound.channelMessageId,
          ...(inbound.text !== undefined ? { text: inbound.text } : {}),
          ...(inbound.media !== undefined ? { media: inbound.media } : {}),
          ...(inbound.action !== undefined ? { action: inbound.action } : {}),
          received_at: receivedAt.toISOString(),
        })
        inboxId = row.id
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

      const turn = await runOneTurn(person, inbound, inboxId, receivedAt)
      return { inboxId, duplicate: false, turn }
    },
  }

  async function runOneTurn(
    person: PersonRow,
    inbound: Inbound,
    inboxId: string,
    receivedAt: Date,
  ): Promise<TurnResult> {
    const startedAt = clock.now()
    const versionRowId = await version()
    const turnRow = await store.turns.insert({
      person_id: person.id,
      // LEARN-2: every turn stores the version it ran under.
      version_id: versionRowId,
      started_at: startedAt.toISOString(),
    })

    const turnEvents = events.about({ personId: person.id, turnId: turnRow.id })
    await turnEvents.record("turn_started", {
      channel: inbound.channel,
      inboxId,
      versionId: versionRowId,
      hasMedia: inbound.media !== undefined,
      hasAction: inbound.action !== undefined,
    })

    // LOOP-7 wants the history *then* the current batch, so history is read
    // before this message joins it. Otherwise the brain sees it twice.
    const history = (await store.messages.list(
      { person_id: person.id },
      // By insert order, so a reply can never sort before its question.
      { orderBy: "seq", ascending: false, limit: config.history },
    )) as MessageRow[]

    const text = inbound.text ?? ""
    await store.messages.insert({
      person_id: person.id,
      turn_id: turnRow.id,
      direction: "inbound",
      author: "person",
      text,
      channel: inbound.channel,
      created_at: receivedAt.toISOString(),
    })

    const result = await runTurn({
      config,
      history: [...history].reverse(),
      store,
      brains: deps.brains,
      models,
      tools,
      clock,
      person,
      // The batch is one message in v0. LOOP-3's burst merge is T2.2.
      batch: [text],
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
    await store.inbox.update({ id: inboxId }, { status: "done", turn_id: turnRow.id })

    await turnEvents.record("turn_ended", {
      outcome: result.outcome,
      steps: result.steps,
      costUsd: result.costUsd,
      latencyMs,
      brains: result.brainsUsed,
      replied: result.reply !== undefined,
      toolsRun: result.toolsRun.length,
    })

    return result
  }

  /** The reply goes out, and is stored whatever the channel does with it. */
  async function deliver(person: PersonRow, turnId: string, text: string): Promise<void> {
    // The outbox, with its retries and states, is T2.3. v0 sends directly.
    await deps.sender.send({
      channel: person.channel,
      channelUserId: person.channel_user_id,
      text,
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
