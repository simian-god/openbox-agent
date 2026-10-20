// EVT-1 to EVT-3 and LEARN-2, wired into a real turn against Postgres.
//
// Events and versions are built in from the start rather than bolted on at
// the end, so every later feature records itself as it lands.
import { test, expect, beforeAll, beforeEach, afterEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { migrate } from "../../src/migrate/index.ts"
import {
  createAgent as buildAgent,
  type Agent,
  type AgentOptions,
  type Deps,
} from "../../src/runtime/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool, type Tool } from "../../src/tools/index.ts"
import { scriptedBrain, type ScriptedStep } from "../../src/testing/scripted-brain.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import type { Brain } from "../../src/providers/brains/types.ts"

// LOOP-2: nothing is handled until a worker runs, and a worker left running
// keeps its poll timer alive after the test. Every agent built here is
// therefore started on the way in and stopped on the way out, by shadowing
// the import rather than touching three dozen call sites.
const started: Agent[] = []

function createAgent(options: AgentOptions): Agent {
  const agent = buildAgent(options)
  agent.start()
  started.push(agent)
  return agent
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((agent) => agent.stop()))
})

const PROMPT = "You are the host at a restaurant."

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: [["11:00", "23:00"]] },
    brain: { id: "openrouter", model: "test/model" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages.",
    retentionDays: 365,
    burstWindowMs: 0,
    ...over,
  })
}

const checkAvailability = defineTool({
  name: "check_availability",
  description: "Checks whether a table is free.",
  input: z.object({ date: z.string(), size: z.number().int().min(1) }),
  risk: "read",
  roles: ["end_user"],
  conditions: {
    callWhen: ["The person asks whether a table is free"],
    dontCallWhen: ["The person is not asking about a booking"],
  },
  examples: { should: ["Any space on Friday?"], shouldNot: ["Hello"] },
  handler: async (args) => ({ free: args.size <= 4 }),
})

const explodingTool = defineTool({
  name: "broken_tool",
  description: "Always fails.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["never, it is for tests"], dontCallWhen: ["always"] },
  examples: { should: ["x"], shouldNot: ["y"] },
  handler: async () => {
    throw new Error("the kitchen is on fire")
  },
})

describeDatabase("events and versions", (sql) => {
  let sender: FakeSender
  let captured: [string, Record<string, unknown>][]
  const clock = fixedClock("2026-10-19T06:00:00Z")

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
    captured = []
    clock.set("2026-10-19T06:00:00Z")
  })

  function agentWith(
    script: ScriptedStep[],
    tools: Tool[] = [checkAvailability],
    over: { config?: Record<string, unknown>; prompt?: string; brains?: Brain[] } = {},
  ): Agent {
    sender = fakeSender()
    const deps: Deps = {
      brains: over.brains ?? [scriptedBrain(script)],
      db: localSupabase(),
      sender,
      clock,
      events: {
        capture: (event, props) => {
          captured.push([event, props])
        },
      },
    }
    return createAgent({
      config: config(over.config ?? {}),
      deps,
      prompt: over.prompt ?? PROMPT,
      tools,
    })
  }

  const hello = (over: Record<string, unknown> = {}) => ({
    channel: "whatsapp",
    channelUserId: "42",
    channelMessageId: "msg-1",
    text: "Any space on Monday?",
    ...over,
  })

  /** Every event this agent wrote, in the order it wrote them. */
  const trace = async (agent: Agent) =>
    (await agent.store.events.list({}, { orderBy: "seq" })).map((row) => row.name)

  test("EVT-1: a turn writes turn_started and turn_ended", async () => {
    const agent = agentWith([{ reply: "We open at 11." }])
    await agent.receiveAndWait(hello())

    expect(await trace(agent)).toEqual(["turn_started", "turn_ended"])
  })

  test("EVT-1: every event is tied to the person and the turn it belongs to", async () => {
    const agent = agentWith([{ reply: "We open at 11." }])
    await agent.receiveAndWait(hello())

    const person = await agent.store.people.find({ channel_user_id: "42" })
    const turn = (await agent.store.turns.list())[0]
    const rows = await agent.store.events.list({}, { orderBy: "seq" })

    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.person_id).toBe(person?.id ?? "")
      expect(row.turn_id).toBe(turn?.id ?? "")
    }
  })

  test("EVT-1: turn_ended carries the outcome, steps, cost and latency", async () => {
    const agent = agentWith([{ reply: "We open at 11." }])
    await agent.receiveAndWait(hello())

    const ended = (await agent.store.events.list({ name: "turn_ended" }))[0]
    expect(ended?.props).toMatchObject({
      outcome: "replied",
      steps: 1,
      costUsd: 0,
      latencyMs: 0,
      replied: true,
      brains: ["scripted"],
    })
  })

  test("EVT-1: turn_ended is written even when every brain fails", async () => {
    const agent = agentWith([], [], { brains: [scriptedBrain([{ throws: "down" }], { id: "x" })] })
    await agent.receiveAndWait(hello())

    const ended = (await agent.store.events.list({ name: "turn_ended" }))[0]
    expect(ended?.props).toMatchObject({ outcome: "brains_failed", replied: false })
  })

  test("EVT-1: tool_ran records a tool that worked", async () => {
    const agent = agentWith([
      { tool: "check_availability", input: { date: "2026-10-19", size: 2 } },
      { reply: "Yes." },
    ])
    await agent.receiveAndWait(hello())

    expect(await trace(agent)).toEqual(["turn_started", "tool_ran", "turn_ended"])
    const ran = (await agent.store.events.list({ name: "tool_ran" }))[0]
    expect(ran?.props).toMatchObject({ tool: "check_availability", ok: true, ran: true, step: 1 })
  })

  test("EVT-1: tool_ran records a tool that threw, with its message", async () => {
    const agent = agentWith([{ tool: "broken_tool" }, { reply: "Let me check." }], [explodingTool])
    await agent.receiveAndWait(hello())

    const ran = (await agent.store.events.list({ name: "tool_ran" }))[0]
    expect(ran?.props).toMatchObject({ tool: "broken_tool", ok: false, ran: true })
    expect(String(ran?.props["error"])).toContain("kitchen is on fire")
  })

  test("EVT-1: arguments the tool never saw are recorded as a call that did not run", async () => {
    const agent = agentWith([
      { tool: "check_availability", input: { date: "2026-10-19", size: 0 } },
      { reply: "How many people?" },
    ])
    await agent.receiveAndWait(hello())

    const ran = (await agent.store.events.list({ name: "tool_ran" }))[0]
    expect(ran?.props).toMatchObject({ tool: "check_availability", ok: false, ran: false })
  })

  test("EVT-2: unknown_tool is recorded when the brain calls what it was not offered", async () => {
    const agent = agentWith([{ tool: "delete_everything" }, { reply: "Sorry." }])
    await agent.receiveAndWait(hello())

    expect(await trace(agent)).toEqual(["turn_started", "unknown_tool", "turn_ended"])
    const row = (await agent.store.events.list({ name: "unknown_tool" }))[0]
    expect(row?.props).toMatchObject({ tool: "delete_everything" })
    expect(row?.props["offered"]).toEqual(["check_availability"])
  })

  test("EVT-2: duplicate_dropped is recorded, and no turn is", async () => {
    const agent = agentWith([{ reply: "one" }, { reply: "two" }])
    await agent.receiveAndWait(hello())
    await agent.receiveAndWait(hello())

    expect(await trace(agent)).toEqual([
      "turn_started",
      "turn_ended",
      // The second delivery of the same message got no turn at all.
      "duplicate_dropped",
    ])
    const row = (await agent.store.events.list({ name: "duplicate_dropped" }))[0]
    expect(row?.props).toMatchObject({ channel: "whatsapp", channelMessageId: "msg-1" })
    expect(row?.turn_id).toBeNull()
  })

  test("EVT-2: fallback_used is recorded when a later brain answers", async () => {
    const agent = agentWith([], [checkAvailability], {
      brains: [
        scriptedBrain([{ throws: "overloaded", retryable: true }], { id: "first" }),
        scriptedBrain([{ reply: "Second brain here." }], { id: "second" }),
      ],
    })
    await agent.receiveAndWait(hello())

    expect(await trace(agent)).toEqual(["turn_started", "fallback_used", "turn_ended"])
    const row = (await agent.store.events.list({ name: "fallback_used" }))[0]
    expect(row?.props).toMatchObject({ brain: "second", step: 1 })
    expect(row?.props["failed"]).toEqual(["first"])
  })

  test("EVT-1: the primary brain answering records no fallback", async () => {
    const agent = agentWith([{ reply: "hi" }])
    await agent.receiveAndWait(hello())

    expect(await trace(agent)).not.toContain("fallback_used")
  })

  test("EVT-1: capture is called with the same events, in the same order", async () => {
    const agent = agentWith([
      { tool: "check_availability", input: { date: "2026-10-19", size: 2 } },
      { reply: "Yes." },
    ])
    await agent.receiveAndWait(hello())

    expect(captured.map(([name]) => name)).toEqual(await trace(agent))
    expect(captured.find(([name]) => name === "tool_ran")?.[1]).toMatchObject({
      tool: "check_availability",
      ok: true,
    })
  })

  test("EVT-3: a brain call is not an event", async () => {
    // Two brain calls in this turn, and no event names either of them.
    const agent = agentWith([
      { tool: "check_availability", input: { date: "2026-10-19", size: 2 } },
      { reply: "Yes." },
    ])
    await agent.receiveAndWait(hello())

    expect(await trace(agent)).toEqual(["turn_started", "tool_ran", "turn_ended"])
  })

  test("EVT-1: an event that cannot be written is never why a person goes unanswered", async () => {
    // Every event write is pointed at a table that does not exist, so the
    // database refuses each one. The conversation must carry on regardless,
    // and the failures must be visible to whoever is running the agent.
    const real = localSupabase()
    const db = {
      from: (name: string) => real.from(name === "ob_events" ? "ob_events_missing" : name),
    } as unknown as ReturnType<typeof localSupabase>

    sender = fakeSender()
    const agent = createAgent({
      config: config(),
      deps: { brains: [scriptedBrain([{ reply: "We open at 11." }])], db, sender, clock },
      prompt: PROMPT,
      tools: [checkAvailability],
    })

    const result = await agent.receiveAndWait(hello())

    expect(result.turn?.outcome).toBe("replied")
    expect(sender.texts()).toEqual(["We open at 11."])
    expect(agent.events.failures.length).toBeGreaterThan(0)
    expect(agent.events.failures[0]?.where).toBe("table")
  })

  test("LEARN-2: the turn records the version it ran under", async () => {
    const agent = agentWith([{ reply: "hi" }])
    await agent.receiveAndWait(hello())

    const turn = (await agent.store.turns.list())[0]
    const version = (await agent.store.versions.list())[0]

    expect(version?.hash).toBe(agent.versionHash)
    expect(turn?.version_id).toBe(version?.id ?? "")
    expect(version?.first_seen_at).toBeTruthy()
  })

  test("LEARN-2: a second turn reuses the same version row", async () => {
    const agent = agentWith([{ reply: "one" }, { reply: "two" }])
    await agent.receiveAndWait(hello())
    await agent.receiveAndWait(hello({ channelMessageId: "msg-2" }))

    expect(await agent.store.versions.count()).toBe(1)
    const versionId = (await agent.store.versions.list())[0]?.id ?? null
    const turns = await agent.store.turns.list({}, { orderBy: "started_at" })
    expect(turns).toHaveLength(2)
    expect(turns.map((turn) => turn.version_id)).toEqual([versionId, versionId])
  })

  test("LEARN-2: a restart with the same agent reuses the version row", async () => {
    const first = agentWith([{ reply: "one" }])
    await first.receiveAndWait(hello())
    // Stopped first, the way a restart really goes. Two live workers on
    // one agent name would both reach for the person, and whichever won
    // would decide which version the turn ran under.
    await first.stop()

    const second = agentWith([{ reply: "two" }])
    await second.receiveAndWait(hello({ channelMessageId: "msg-2" }))

    expect(second.versionHash).toBe(first.versionHash)
    expect(await second.store.versions.count()).toBe(1)
  })

  test("LEARN-2: a changed prompt is a second version row", async () => {
    const first = agentWith([{ reply: "one" }])
    await first.receiveAndWait(hello())

    // The old deployment stops before the new one starts, so the second
    // turn can only have run under the new prompt.
    await first.stop()

    const changed = agentWith([{ reply: "two" }], [checkAvailability], {
      prompt: "You are the host at a dentist.",
    })
    await changed.receiveAndWait(hello({ channelMessageId: "msg-2" }))

    expect(changed.versionHash).not.toBe(first.versionHash)
    expect(await changed.store.versions.count()).toBe(2)

    const ids = (await changed.store.turns.list({}, { orderBy: "started_at" })).map(
      (turn) => turn.version_id,
    )
    expect(ids.filter((id) => id !== null)).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  test("DATA-1: another agent on the same database sees none of these events", async () => {
    const agent = agentWith([{ reply: "hi" }])
    await agent.receiveAndWait(hello())

    const other = createAgent({
      config: config({ name: "dentist" }),
      deps: {
        brains: [scriptedBrain([{ reply: "hi" }])],
        db: localSupabase(),
        sender: fakeSender(),
        clock,
      },
      prompt: PROMPT,
      tools: [],
    })

    expect(await other.store.events.count()).toBe(0)
    expect(await other.store.versions.count()).toBe(0)
    expect(await agent.store.events.count()).toBeGreaterThan(0)
  })
})
