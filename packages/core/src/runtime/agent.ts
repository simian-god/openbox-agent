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
  StoreError,
  type MessageRow,
  type PersonRow,
  type Store,
} from "../store/index.ts"
import { createToolRegistry, type Tool, type ToolRegistry } from "../tools/index.ts"
import type { Clock } from "../testing/clock.ts"
import { systemClock } from "../testing/clock.ts"
import type { Inbound, Sender } from "./sender.ts"
import { runTurn, type TurnResult } from "./turn.ts"

export interface Deps {
  /** The first is the primary, the rest are fallbacks in order. */
  brains: Brain[]
  db: SupabaseClient
  sender: Sender
  clock?: Clock | undefined
  // decisionModel, transcriber, retriever and events join Deps as the
  // features that need them land, in M3, M7, M8 and T1.7. They are left
  // out rather than stubbed, so nothing can quietly depend on a fake.
}

export interface AgentOptions {
  config: OpenboxConfig
  deps: Deps
  /** The static system prompt, prompt.md in a real agent (SKILL-8). */
  prompt: string
  tools?: Tool[]
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
  receive(inbound: Inbound): Promise<ReceiveResult>
}

/** Postgres' code for a unique constraint violation. */
const UNIQUE_VIOLATION = "23505"

function isDuplicate(error: unknown): boolean {
  // The store wraps the database's error, so the code sits on the wrapper
  // or on what it wrapped, depending on who threw.
  if (error instanceof StoreError) return error.code === UNIQUE_VIOLATION
  if (error === null || typeof error !== "object") return false
  return (error as { code?: unknown }).code === UNIQUE_VIOLATION
}

export function createAgent(options: AgentOptions): Agent {
  const { config, deps, prompt } = options
  const clock = deps.clock ?? systemClock
  const store = createStore(deps.db, config.name)
  const tools = createToolRegistry(options.tools ?? [])

  // CFG-1's last rule needs the tools, which config alone cannot see.
  const problems = options.tools
    ?.filter((tool) => tool.risk === "irreversible" && tool.confirmSummary === undefined)
    .map((tool) => `${tool.name} is irreversible but has no confirmSummary`)
  if (problems !== undefined && problems.length > 0) {
    throw new Error(`This agent cannot start:\n${problems.map((p) => `  - ${p}`).join("\n")}`)
  }

  const models = [config.brain, ...config.brain.fallbacks].map((entry) => entry.model)

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
      if (!isDuplicate(error)) throw error
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
        if (!isDuplicate(error)) throw error
        const existing = await store.inbox.find({
          person_id: person.id,
          channel_message_id: inbound.channelMessageId,
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
    const turnRow = await store.turns.insert({
      person_id: person.id,
      started_at: startedAt.toISOString(),
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
    })

    if (result.reply !== undefined) {
      await deliver(person, turnRow.id, result.reply)
    }

    // LOOP-11: the turn records what it did.
    await store.turns.update(
      { id: turnRow.id },
      {
        brains: result.brainsUsed,
        steps: result.steps,
        cost_usd: result.costUsd,
        latency_ms: clock.now().getTime() - startedAt.getTime(),
        outcome: result.outcome,
        ended_at: clock.now().toISOString(),
      },
    )
    await store.inbox.update({ id: inboxId }, { status: "done", turn_id: turnRow.id })

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
