// Turn v0 end to end: a message arrives, a person is created, the brain
// runs its steps, and a reply goes out through the sender.
import { test, expect, describe, beforeAll, beforeEach } from "bun:test"
import { scriptedDecisionModel, choice, yesno } from "../../src/testing/scripted-decision.ts"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { check } from "../support/waiting.ts"
import { migrate } from "../../src/migrate/index.ts"
import { type Agent, type AgentOptions, type Deps } from "../../src/runtime/index.ts"
import { BRAINS_FAILED_REPLY } from "../../src/runtime/limits.ts"
import { PERSON_TOLD } from "../../src/runtime/handover.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool, type Tool } from "../../src/tools/index.ts"
import {
  scriptedBrain,
  type ScriptedBrain,
  type ScriptedStep,
} from "../../src/testing/scripted-brain.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { WANTS_HUMAN } from "../../src/runtime/handover.ts"

// LOOP-2: nothing is handled until a worker runs, and a worker left running
// keeps its poll timer alive after the test. Every agent built here is
// therefore started on the way in and stopped on the way out, by shadowing
// the import rather than touching three dozen call sites.
const agents = trackAgents("turn.test.ts")

function createAgent(options: AgentOptions): Agent {
  // CONF-3: an agent with an irreversible tool needs a signing secret, so
  // every agent here gets one. A test that wants to prove the refusal
  // passes its own.
  return agents.create({ secret: "test-secret", ...options })
}

/**
 * The agent's own tools out of what the brain was offered.
 *
 * BUILTIN-1: the core's tools are offered on every step whatever routing
 * decides, so a test about routing has to look past them. Filtering by the
 * registry rather than by a hard coded list, so the next built in does not
 * break these again.
 */
const agentToolsIn = (offered: { name: string }[] | undefined, agent: Agent): string[] => {
  const builtins = new Set(agent.tools.builtins().map((tool) => tool.name))
  return (offered ?? []).map((tool) => tool.name).filter((name) => !builtins.has(name))
}

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

/** A read tool that reports what it was given, so ctx can be inspected. */
let lastCtx: Record<string, unknown> | undefined

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
  handler: async (args, ctx) => {
    lastCtx = {
      personId: ctx.person.id,
      role: ctx.person.role,
      channel: ctx.person.channel,
      channelUserId: ctx.person.channelUserId,
      now: ctx.clock.now().toISOString(),
      hasDb: typeof ctx.db.table === "function",
      hasLog: typeof ctx.log === "function",
    }
    return { free: args.size <= 4 }
  },
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

const operatorOnly = defineTool({
  name: "operator_report",
  description: "An operator only report.",
  input: z.object({}),
  risk: "read",
  roles: ["operator"],
  conditions: { callWhen: ["an operator asks"], dontCallWhen: ["an end user asks"] },
  examples: { should: ["report"], shouldNot: ["hello"] },
  handler: async () => ({ ok: true }),
})

const bookTable = defineTool({
  name: "book_table",
  description: "Books a table.",
  input: z.object({ size: z.number().int() }),
  risk: "irreversible",
  roles: ["end_user"],
  conditions: { callWhen: ["a booking is agreed"], dontCallWhen: ["only asking"] },
  confirmSummary: (args) => `Table for ${args.size}`,
  examples: { should: ["book it"], shouldNot: ["just asking"] },
  handler: async () => ({ booked: true }),
})

/** A write tool: reversible, so the gate can let it run (GATE-2). */
const updateBooking = defineTool({
  name: "update_booking",
  description: "Changes a booking that already exists.",
  input: z.object({ size: z.number().int().min(1) }),
  risk: "write",
  roles: ["end_user"],
  conditions: {
    callWhen: ["The person has asked to change a booking they have"],
    dontCallWhen: ["The person has no booking yet"],
  },
  examples: { should: ["make it six instead"], shouldNot: ["Hello"] },
  handler: async (args) => ({ changed: true, size: args.size }),
})

describeDatabase("a turn", (sql) => {
  let sender: FakeSender
  const clock = fixedClock("2026-10-19T06:00:00Z")

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
    lastCtx = undefined
  })

  /** An agent wired to a scripted brain and a recording sender. */
  function agentWith(
    script: ScriptedStep[],
    tools: Tool[] = [checkAvailability],
    over: Record<string, unknown> = {},
  ): { agent: Agent; brain: ScriptedBrain } {
    const brain = scriptedBrain(script)
    sender = fakeSender()
    const deps: Deps = {
      decisionModel: scriptedDecisionModel([]),
      brains: [brain],
      db: localSupabase(),
      sender,
      clock,
    }
    return { agent: createAgent({ config: config(over), deps, prompt: PROMPT, tools }), brain }
  }

  const hello = (over: Record<string, unknown> = {}) => ({
    channel: "whatsapp",
    channelUserId: "42",
    channelMessageId: "msg-1",
    text: "Any space on Monday?",
    ...over,
  })

  test("ROLE-1: an unknown person is created as an end user", async () => {
    const { agent } = agentWith([{ reply: "We open at 11." }])
    await agent.receiveAndWait(hello({ displayName: "Asha" }))

    const person = await agent.store.people.find({ channel_user_id: "42" })
    expect(person?.role).toBe("end_user")
    expect(person?.channel).toBe("whatsapp")
    expect(person?.display_name).toBe("Asha")
  })

  test("ROLE-1: a person who writes again is the same person, not a new one", async () => {
    const { agent } = agentWith([{ reply: "one" }, { reply: "two" }])
    await agent.receiveAndWait(hello())
    await agent.receiveAndWait(hello({ channelMessageId: "msg-2" }))

    expect(await agent.store.people.count()).toBe(1)
  })

  test("API-3: nothing in a message can set a role", async () => {
    const { agent } = agentWith([{ reply: "hi" }])
    // The glue has no way to pass a role, so a sender claiming one is
    // simply ignored rather than trusted.
    await agent.receiveAndWait({ ...hello(), role: "operator" } as never)

    const person = await agent.store.people.find({ channel_user_id: "42" })
    expect(person?.role).toBe("end_user")
  })

  test("ROLE-1: an operator's role survives a message from them", async () => {
    const { agent } = agentWith([{ reply: "hi" }])
    await agent.receiveAndWait(hello())
    await agent.store.people.update({ channel_user_id: "42" }, { role: "operator" })

    await agent.receiveAndWait(hello({ channelMessageId: "msg-2" }))
    const person = await agent.store.people.find({ channel_user_id: "42" })
    expect(person?.role).toBe("operator")
  })

  test("LOOP-1: the same channel message id twice is a duplicate", async () => {
    const { agent, brain } = agentWith([{ reply: "one" }, { reply: "two" }])

    const first = await agent.receiveAndWait(hello())
    const second = await agent.receiveAndWait(hello())

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    // Nothing else happened: no second turn, no second reply.
    expect(brain.calls).toHaveLength(1)
    expect(sender.sent).toHaveLength(1)
    expect(await agent.store.inbox.count()).toBe(1)
  })

  test("LOOP-8: a reply ends the turn and goes out through the sender", async () => {
    const { agent } = agentWith([{ reply: "We open at 11." }])
    const result = await agent.receiveAndWait(hello())

    // Wrapped in `check` because this is one of the two tests that have
    // stalled under the full run (Known K14). A failure here says what the
    // agent was holding, which is what tells a stall from a wrong answer.
    await check(agent, undefined, () => {
      expect(result.turn?.outcome).toBe("replied")
      expect(result.turn?.steps).toBe(1)
      expect(sender.texts()).toEqual(["We open at 11."])
      expect(sender.sent[0]?.channel).toBe("whatsapp")
      expect(sender.sent[0]?.channelUserId).toBe("42")
      expect(sender.sent[0]?.idempotencyKey).toBeTruthy()
    })
  })

  test("LOOP-8: a read tool runs, and its result goes back to the brain", async () => {
    const { agent, brain } = agentWith([
      { tool: "check_availability", input: { date: "2026-10-19", size: 2 } },
      { reply: "Yes, we have space." },
    ])
    const result = await agent.receiveAndWait(hello())

    expect(result.turn?.toolsRun).toEqual([{ name: "check_availability", ok: true }])
    expect(result.turn?.steps).toBe(2)

    // Step 10: the second call carries the call and its result.
    const second = brain.calls[1]?.messages ?? []
    expect(second.at(-2)).toMatchObject({ role: "tool_call", name: "check_availability" })
    expect(second.at(-1)).toMatchObject({ role: "tool_result", result: { free: true } })
  })

  test("LOOP-8: a tool the brain was not given is refused, never run", async () => {
    const { agent, brain } = agentWith([{ tool: "delete_everything" }, { reply: "Sorry." }])
    const result = await agent.receiveAndWait(hello())

    expect(result.turn?.toolsRun).toEqual([])

    const told = brain.calls[1]?.messages.at(-1) as { error?: string }
    expect(told.error).toContain("no tool called delete_everything")
    // It is told what it can call, so the next step can be right.
    expect(told.error).toContain("check_availability")
  })

  test("LOOP-8: bad arguments go back as an error, and the tool never runs", async () => {
    const { agent, brain } = agentWith([
      { tool: "check_availability", input: { date: "2026-10-19", size: 0 } },
      { reply: "How many people?" },
    ])
    const result = await agent.receiveAndWait(hello())

    expect(result.turn?.toolsRun).toEqual([])
    const told = brain.calls[1]?.messages.at(-1) as { error?: string }
    expect(told.error).toContain("not valid")
    expect(told.error).toContain("size")
  })

  test("LOOP-8: a tool that throws is reported to the brain, not to the person", async () => {
    const { agent, brain } = agentWith(
      [{ tool: "broken_tool" }, { reply: "Let me check and come back." }],
      [checkAvailability, explodingTool],
    )
    const result = await agent.receiveAndWait(hello())

    expect(result.turn?.toolsRun).toEqual([{ name: "broken_tool", ok: false }])
    const told = brain.calls[1]?.messages.at(-1) as { error?: string }
    expect(told.error).toContain("kitchen is on fire")
    // The person gets the brain's words, never the exception.
    expect(sender.texts()).toEqual(["Let me check and come back."])
  })

  test("TOOL-4: the handler is given the person, the clock, the tables and a log", async () => {
    const { agent } = agentWith([
      { tool: "check_availability", input: { date: "2026-10-19", size: 2 } },
      { reply: "Yes." },
    ])
    await agent.receiveAndWait(hello())

    const person = await agent.store.people.find({ channel_user_id: "42" })
    expect(lastCtx).toEqual({
      personId: person?.id,
      role: "end_user",
      channel: "whatsapp",
      channelUserId: "42",
      // TIME-1: the injected clock, not the machine's.
      now: "2026-10-19T06:00:00.000Z",
      hasDb: true,
      hasLog: true,
    })
  })

  test("ROLE-3: a tool another role owns is never offered", async () => {
    const { agent, brain } = agentWith([{ reply: "hi" }], [checkAvailability, operatorOnly])
    await agent.receiveAndWait(hello())

    const offered = agentToolsIn(brain.calls[0]?.tools, agent)
    expect(offered).toContain("check_availability")
    expect(offered).not.toContain("operator_report")
  })

  test("LOOP-8: every risk level is offered, because the gate decides, not the exposure", async () => {
    // This test was the opposite before T3.5: with no gate, a write or
    // irreversible tool was simply never mentioned to the brain. A tool
    // the brain cannot see is a tool the agent cannot use, so withholding
    // them was only ever a stand in for the gate.
    const { agent, brain } = agentWith([{ reply: "hi" }], [checkAvailability, bookTable])
    await agent.receiveAndWait(hello())

    expect(agentToolsIn(brain.calls[0]?.tools, agent)).toEqual(["check_availability", "book_table"])
  })

  test("LOOP-7: the brain gets the prompt, the runtime block and the message", async () => {
    const { agent, brain } = agentWith([{ reply: "hi" }])
    await agent.receiveAndWait(hello())

    const call = brain.calls[0]
    expect(call?.system).toContain(PROMPT)
    expect(call?.system).toContain("Monday")
    expect(call?.system).toContain("Asia/Kolkata")
    expect(call?.messages).toEqual([{ role: "person", text: "Any space on Monday?" }])
  })

  test("LOOP-7: an earlier turn's messages are the next turn's history", async () => {
    const { agent, brain } = agentWith([{ reply: "We open at 11." }, { reply: "Yes." }])
    await agent.receiveAndWait(hello())
    await agent.receiveAndWait(hello({ channelMessageId: "msg-2", text: "Are you open now?" }))

    expect(brain.calls[1]?.messages).toEqual([
      { role: "person", text: "Any space on Monday?" },
      { role: "agent", text: "We open at 11." },
      { role: "person", text: "Are you open now?" },
    ])
  })

  test("LOOP-7: history is capped at the configured number of messages", async () => {
    const { agent, brain } = agentWith(
      [{ reply: "a" }, { reply: "b" }, { reply: "c" }],
      [checkAvailability],
      { history: 2 },
    )
    await agent.receiveAndWait(hello({ channelMessageId: "m1", text: "one" }))
    await agent.receiveAndWait(hello({ channelMessageId: "m2", text: "two" }))
    await agent.receiveAndWait(hello({ channelMessageId: "m3", text: "three" }))

    // Two from history, plus the message being answered.
    expect(brain.calls[2]?.messages).toHaveLength(3)
  })

  // LOOP-11 also wants the version (T1.7), the outbox (T2.3) and the lease
  // (T2.2). Only the turn record itself is proven here.
  test("the turn records its steps, cost, brains and outcome", async () => {
    const { agent } = agentWith([
      { tool: "check_availability", input: { date: "2026-10-19", size: 2 } },
      { reply: "Yes." },
    ])
    await agent.receiveAndWait(hello())

    const turn = (await agent.store.turns.list())[0]
    expect(turn?.steps).toBe(2)
    expect(turn?.outcome).toBe("replied")
    expect(turn?.brains).toEqual(["scripted", "scripted"])
    expect(turn?.ended_at).not.toBeNull()
    expect(turn?.latency_ms).not.toBeNull()
  })

  test("LOOP-8: the conversation is stored in both directions", async () => {
    const { agent } = agentWith([{ reply: "We open at 11." }])
    await agent.receiveAndWait(hello())

    const messages = await agent.store.messages.list({}, { orderBy: "seq" })
    expect(messages.map((row) => [row.direction, row.author, row.text])).toEqual([
      ["inbound", "person", "Any space on Monday?"],
      ["outbound", "agent", "We open at 11."],
    ])
  })

  test("LOOP-7: order holds even when two messages share an instant", async () => {
    // The clock is frozen, so the question and the reply carry the same
    // created_at. Order must come from insert order, not from the time.
    const { agent, brain } = agentWith([{ reply: "We open at 11." }, { reply: "Yes." }])
    await agent.receiveAndWait(hello())
    await agent.receiveAndWait(hello({ channelMessageId: "msg-2", text: "Are you open now?" }))

    const stored = await agent.store.messages.list({}, { orderBy: "seq" })
    expect(new Set(stored.map((row) => row.created_at)).size).toBe(1)
    expect(stored.map((row) => row.text)).toEqual([
      "Any space on Monday?",
      "We open at 11.",
      "Are you open now?",
      "Yes.",
    ])

    // And the brain sees that same order.
    expect(brain.calls[1]?.messages).toEqual([
      { role: "person", text: "Any space on Monday?" },
      { role: "agent", text: "We open at 11." },
      { role: "person", text: "Are you open now?" },
    ])
  })

  test("LOOP-8: the inbox row is marked done and tied to its turn", async () => {
    const { agent } = agentWith([{ reply: "hi" }])
    const result = await agent.receiveAndWait(hello())

    const row = await agent.store.inbox.byId(result.inboxId)
    expect(row?.status).toBe("done")
    expect(row?.turn_id).not.toBeNull()
  })

  test("LOOP-8: a turn cannot run forever", async () => {
    const { agent } = agentWith(
      [{ tool: "check_availability", input: { date: "d", size: 1 } }],
      [checkAvailability],
      { maxSteps: 3 },
    )
    // The script repeats its last step, so the brain never replies.
    const brain = scriptedBrain([{ tool: "check_availability", input: { date: "d", size: 1 } }], {
      whenExhausted: "repeat-last",
    })
    sender = fakeSender()
    const looping = createAgent({
      config: config({ maxSteps: 3 }),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [brain],
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: PROMPT,
      tools: [checkAvailability],
    })

    const result = await looping.receiveAndWait(hello())
    expect(result.turn?.outcome).toBe("step_cap")
    expect(result.turn?.steps).toBe(3)
    void agent
  })

  test("LOOP-8: when the brain says nothing, nothing is sent", async () => {
    const { agent } = agentWith([
      { output: { finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } } },
    ])
    const result = await agent.receiveAndWait(hello())

    expect(result.turn?.outcome).toBe("no_reply")
    expect(sender.sent).toEqual([])
  })

  // BRAIN-5 proper, including two malformed outputs in a row, is T5.5.
  test("a failing brain hands over to the next one", async () => {
    const failing = scriptedBrain([{ throws: "overloaded", retryable: true }], { id: "first" })
    const working = scriptedBrain([{ reply: "Second brain here." }], { id: "second" })
    sender = fakeSender()

    const agent = createAgent({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [failing, working],
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: PROMPT,
      tools: [checkAvailability],
    })

    const result = await agent.receiveAndWait(hello())
    expect(result.turn?.brainsUsed).toEqual(["second"])
    expect(sender.texts()).toEqual(["Second brain here."])
  })

  test("LOOP-12: when every brain fails the person is told so, and a colleague is", async () => {
    const failing = scriptedBrain([{ throws: "down" }], { id: "only" })
    sender = fakeSender()

    const agent = createAgent({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [failing],
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: PROMPT,
      tools: [],
    })

    const result = await agent.receiveAndWait(hello())
    expect(result.turn?.outcome).toBe("brains_failed")
    // LOOP-12: the fixed holding message, and then HAND-2's own line,
    // because a promise that somebody will come back needs an owner.
    // Nothing here pretends to be an answer.
    expect(sender.texts()).toEqual([BRAINS_FAILED_REPLY, PERSON_TOLD])
    const [handover] = await agent.store.handovers.list()
    expect(handover?.reason).toBe("brains_failed")
    // No summary: there is no brain left to write one with.
    expect(handover?.summary).toBeNull()
  })

  test("DATA-1: a second agent on the same database sees none of this", async () => {
    const { agent } = agentWith([{ reply: "hi" }])
    await agent.receiveAndWait(hello())

    const other = createAgent({
      config: config({ name: "dentist" }),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [scriptedBrain([{ reply: "hi" }])],
        db: localSupabase(),
        sender: fakeSender(),
        clock,
      },
      prompt: PROMPT,
      tools: [],
    })

    expect(await other.store.people.count()).toBe(0)
    expect(await agent.store.people.count()).toBe(1)
  })

  // ROUTE-1 to ROUTE-5 are proven on their own in test/unit/routing.test.ts.
  // What only a real turn can show is ROUTE-3: that routing runs again on
  // every step, so a second step can route somewhere else.
  describe("ROUTE-3: routing on every step", () => {
    /** Six read tools, which is one more than routing's default minimum. */
    const six = (): Tool[] =>
      ["one", "two", "three", "four", "five", "six"].map((name) =>
        defineTool({
          name: `look_up_${name}`,
          description: `Looks up ${name}.`,
          input: z.object({}),
          risk: "read",
          roles: ["end_user"],
          conditions: {
            callWhen: [`the person asks about ${name}`],
            dontCallWhen: [`the person is not asking about ${name}`],
          },
          examples: { should: [`about ${name}`], shouldNot: ["hello"] },
          handler: async () => ({ found: name }),
        }),
      )

    test("ROUTE-3: a two step turn routes twice, and the second step can route elsewhere", async () => {
      const tools = six()
      const brain = scriptedBrain([{ tool: "look_up_one", input: {} }, { reply: "Here you go." }])
      const decisions = scriptedDecisionModel([
        { tool: choice("look_up_one", { look_up_one: 0.95, no_tool: 0.05 }) },
        { tool: choice("look_up_four", { look_up_four: 0.92, no_tool: 0.08 }) },
      ])
      sender = fakeSender()
      const agent = createAgent({
        config: config(),
        deps: { brains: [brain], decisionModel: decisions, db: localSupabase(), sender, clock },
        prompt: PROMPT,
        tools,
      })

      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.outcome).toBe("replied")
      // Once per step, not once per turn.
      expect(decisions.calls).toHaveLength(2)
      expect(result.turn?.routed.map((entry) => entry.choice)).toEqual([
        "look_up_one",
        "look_up_four",
      ])

      // And the brain saw only what each step routed to.
      expect(agentToolsIn(brain.calls[0]?.tools, agent)).toEqual(["look_up_one"])
      expect(agentToolsIn(brain.calls[1]?.tools, agent)).toEqual(["look_up_four"])
    })

    test("ROUTE-3: every routed step records route_decided", async () => {
      const captured: [string, Record<string, unknown>][] = []
      const brain = scriptedBrain([{ tool: "look_up_one", input: {} }, { reply: "Done." }])
      const decisions = scriptedDecisionModel([
        { tool: choice("look_up_one", { look_up_one: 0.95, no_tool: 0.05 }) },
        { tool: choice("no_tool", { no_tool: 0.9, look_up_one: 0.1 }) },
      ])
      sender = fakeSender()
      const agent = createAgent({
        config: config(),
        deps: {
          brains: [brain],
          decisionModel: decisions,
          db: localSupabase(),
          sender,
          clock,
          events: {
            capture: (event, props) => {
              captured.push([event, props])
            },
          },
        },
        prompt: PROMPT,
        tools: six(),
      })

      await agent.receiveAndWait(hello())

      const routed = captured.filter(([name]) => name === "route_decided")
      expect(routed).toHaveLength(2)
      expect(routed[0]?.[1]["reason"]).toBe("top_pick")
      expect(routed[1]?.[1]["reason"]).toBe("no_tool")
      // A confident no_tool means the second step was offered no agent
      // tools. The core's own are there either way (BUILTIN-1), and for
      // an end user those are the two fact tools and `escalate`.
      expect(routed[1]?.[1]["exposed"]).toEqual(["remember", "forget_fact", "escalate"])
    })

    test("ROUTE-5: a decision model that is down still answers the person", async () => {
      // The point of failing open. The person must not notice that an
      // optimisation was unavailable.
      const captured: [string, Record<string, unknown>][] = []
      const brain = scriptedBrain([{ reply: "We open at 11." }])
      const down = scriptedDecisionModel([{ throws: "the provider is down", retryable: true }])
      sender = fakeSender()
      const agent = createAgent({
        config: config(),
        deps: {
          brains: [brain],
          decisionModel: down,
          db: localSupabase(),
          sender,
          clock,
          events: {
            capture: (event, props) => {
              captured.push([event, props])
            },
          },
        },
        prompt: PROMPT,
        tools: six(),
      })

      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.outcome).toBe("replied")
      expect(sender.sent[0]?.text).toBe("We open at 11.")
      // Every tool was offered, exactly as a below threshold answer would.
      expect(agentToolsIn(brain.calls[0]?.tools, agent)).toHaveLength(6)

      const fell = captured.filter(([name]) => name === "fallback_used")
      expect(fell).toHaveLength(1)
      // The same event name as a brain fallback, so `what` separates them.
      expect(fell[0]?.[1]["what"]).toBe("decision_model")
    })

    test("ROUTE-1: an agent with few tools records no routing at all", async () => {
      const captured: [string, Record<string, unknown>][] = []
      const brain = scriptedBrain([{ reply: "We open at 11." }])
      const decisions = scriptedDecisionModel([])
      sender = fakeSender()
      const agent = createAgent({
        config: config(),
        deps: {
          brains: [brain],
          decisionModel: decisions,
          db: localSupabase(),
          sender,
          clock,
          events: {
            capture: (event, props) => {
              captured.push([event, props])
            },
          },
        },
        prompt: PROMPT,
        tools: [checkAvailability],
      })

      await agent.receiveAndWait(hello())

      // One request, and routing is not in it. LOOP-8 step 1 asks
      // `wants_human` on every first step (HAND-1), so the question is
      // not whether a request was made but what was in it.
      expect(decisions.calls).toHaveLength(1)
      expect(Object.keys(decisions.calls[0]?.questions ?? {})).toEqual([WANTS_HUMAN])
      expect(captured.filter(([name]) => name === "route_decided")).toHaveLength(0)
      expect(agentToolsIn(brain.calls[0]?.tools, agent)).toEqual(["check_availability"])
    })
  })

  describe("GATE-1 to GATE-5: the gate on a real turn", () => {
    /** An agent whose decision model answers the gate with one probability. */
    function gated(
      script: ScriptedStep[],
      p: number | { throws: string },
      tools: Tool[] = [checkAvailability, updateBooking],
    ): { agent: Agent; brain: ScriptedBrain; captured: [string, Record<string, unknown>][] } {
      const captured: [string, Record<string, unknown>][] = []
      const brain = scriptedBrain(script)
      // Two tools, so routing is not asked (ROUTE-1) and the only decision
      // request a step makes is the gate's.
      const decisions =
        typeof p === "number"
          ? scriptedDecisionModel([{ [GATE_QUESTION]: yesno(p) }])
          : scriptedDecisionModel([p])
      sender = fakeSender()
      const agent = createAgent({
        config: config(),
        deps: {
          brains: [brain],
          decisionModel: decisions,
          db: localSupabase(),
          sender,
          clock,
          events: {
            capture: (event, props) => {
              captured.push([event, props])
            },
          },
        },
        prompt: PROMPT,
        tools,
      })
      return { agent, brain, captured }
    }

    const change = { tool: "update_booking", input: { size: 6 } } as const

    /** Six read tools, which is one more than routing's default minimum. */
    const six = (): Tool[] =>
      ["one", "two", "three", "four", "five", "six"].map((name) =>
        defineTool({
          name: `look_up_${name}`,
          description: `Looks up ${name}.`,
          input: z.object({}),
          risk: "read",
          roles: ["end_user"],
          conditions: {
            callWhen: [`the person asks about ${name}`],
            dontCallWhen: [`the person is not asking about ${name}`],
          },
          examples: { should: [`about ${name}`], shouldNot: ["hello"] },
          handler: async () => ({ found: name }),
        }),
      )

    test("GATE-2: a write the gate passes runs, and the person gets the answer", async () => {
      const { agent, brain, captured } = gated([change, { reply: "Changed to six." }], 0.9)
      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.outcome).toBe("replied")
      expect(result.turn?.toolsRun).toEqual([{ name: "update_booking", ok: true }])
      expect(sender.texts()).toEqual(["Changed to six."])
      // The handler really ran, and its result went back to the brain.
      const back = brain.calls[1]?.messages.at(-1) as { result?: unknown }
      expect(back.result).toEqual({ changed: true, size: 6 })
      expect(captured.filter(([name]) => name === "gate_passed")).toHaveLength(1)
    })

    test("GATE-2: a write the gate blocks never reaches the handler", async () => {
      const { agent, brain, captured } = gated(
        [change, { reply: "Let me check that with someone." }],
        0.1,
      )
      const result = await agent.receiveAndWait(hello())

      // Nothing ran, and the person still got an answer.
      expect(result.turn?.toolsRun).toEqual([])
      expect(sender.texts()).toEqual(["Let me check that with someone."])

      // The brain was told, and told enough to do something else.
      const told = brain.calls[1]?.messages.at(-1) as { error?: string }
      expect(told.error).toContain("blocked")
      expect(told.error).toContain("Do not call it again")

      const blocked = captured.filter(([name]) => name === "guard_block")
      expect(blocked).toHaveLength(1)
      expect(blocked[0]?.[1]["tool"]).toBe("update_booking")
    })

    test("GATE-2: a write in the Confirm band is not run either", async () => {
      const { agent, brain } = gated([change, { reply: "Shall I change it to six?" }], 0.55)
      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.toolsRun).toEqual([])
      const told = brain.calls[1]?.messages.at(-1) as { error?: string }
      expect(told.error).toContain("confirm")
      // GATE-2 asks for the condition in doubt. One yes/no gives one
      // number, so every condition is quoted (docs/Known.md K12).
      expect(told.error).toContain("The person has asked to change a booking they have")
    })

    test("GATE-4: an irreversible call is not run on a confident yes", async () => {
      // CONF-1's structured confirm is M4. Until it exists an irreversible
      // call cannot run at all, which is the safe half of the rule.
      const { agent, brain } = gated(
        [{ tool: "book_table", input: { size: 4 } }, { reply: "I will confirm that with you." }],
        1,
        [checkAvailability, bookTable],
      )
      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.toolsRun).toEqual([])
      const told = brain.calls[1]?.messages.at(-1) as { error?: string }
      expect(told.error).toContain("cannot be undone")
    })

    test("GATE-4: a decision model that is down does not run the write", async () => {
      const { agent, brain, captured } = gated(
        [change, { reply: "Can you confirm that change?" }],
        { throws: "the provider is down" },
      )
      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.toolsRun).toEqual([])
      expect(result.turn?.outcome).toBe("replied")
      const told = brain.calls[1]?.messages.at(-1) as { error?: string }
      expect(told.error).toContain("confirm")

      const confirmed = captured.filter(([name]) => name === "gate_confirm")
      expect(confirmed[0]?.[1]["reason"]).toBe("failed_closed")
    })

    test("GATE-4 and ROUTE-5: one outage, routing open and the gate closed", async () => {
      // The whole arrangement in one turn. Routing cannot reach the model,
      // so the brain sees every tool, including the write. The gate cannot
      // reach it either, so the write does not run.
      const brain = scriptedBrain([change, { reply: "Can you confirm that?" }])
      const down = scriptedDecisionModel([{ throws: "the provider is down" }])
      sender = fakeSender()
      const agent = createAgent({
        config: config(),
        deps: { brains: [brain], decisionModel: down, db: localSupabase(), sender, clock },
        prompt: PROMPT,
        tools: [...six(), updateBooking],
      })

      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.routed[0]?.reason).toBe("fallback")
      expect(brain.calls[0]?.tools.map((tool) => tool.name)).toContain("update_booking")
      expect(result.turn?.toolsRun).toEqual([])
      expect(result.turn?.outcome).toBe("replied")
    })

    test("GATE-5: a read tool is never asked about", async () => {
      const { agent } = gated(
        [
          { tool: "check_availability", input: { date: "2026-10-19", size: 2 } },
          { reply: "Yes, we have space." },
        ],
        0,
      )
      const result = await agent.receiveAndWait(hello())

      // A 0 from the decision model, and the read tool ran anyway.
      expect(result.turn?.toolsRun).toEqual([{ name: "check_availability", ok: true }])
      expect(await agent.store.decisions.count({ kind: "gate" })).toBe(0)
    })

    test("DATA-2: a tool run records the arguments the brain proposed", async () => {
      // Known K6: this is what the event trace could not say, and what an
      // evals assertion of the form "must call X with these arguments"
      // needs from the core rather than from an adapter watching.
      const { agent } = gated([change, { reply: "Done." }], 0.9)
      await agent.receiveAndWait(hello())

      const runs = await agent.store.toolRuns.list({}, { orderBy: "seq" })
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({
        tool: "update_booking",
        risk: "write",
        status: "ok",
        args: { size: 6 },
        result: { changed: true, size: 6 },
        step: 1,
      })
      expect(runs[0]?.turn_id).not.toBeNull()
    })

    test("DATA-2: a blocked call is a tool run too, because it happened", async () => {
      const { agent } = gated([change, { reply: "I cannot do that yet." }], 0.1)
      await agent.receiveAndWait(hello())

      const runs = await agent.store.toolRuns.list({}, { orderBy: "seq" })
      expect(runs[0]).toMatchObject({
        tool: "update_booking",
        status: "blocked",
        args: { size: 6 },
        result: null,
      })
      expect(runs[0]?.error).toContain("block")
    })

    test("DATA-2: every gate call is in the decisions table with what it answered", async () => {
      const { agent } = gated([change, { reply: "Done." }], 0.9)
      await agent.receiveAndWait(hello())

      const decided = await agent.store.decisions.list({ kind: "gate" }, { orderBy: "seq" })
      expect(decided).toHaveLength(1)
      expect(decided[0]).toMatchObject({ kind: "gate", outcome: "pass", model: "scripted" })
      expect(decided[0]?.answers).toMatchObject({ [GATE_QUESTION]: { type: "yesno", p: 0.9 } })
    })

    test("LEARN-1: a Block raises a gate_block flag", async () => {
      const { agent, captured } = gated([change, { reply: "I cannot do that." }], 0.1)
      await agent.receiveAndWait(hello())

      const flags = await agent.store.flags.list({}, { orderBy: "seq" })
      expect(flags).toHaveLength(1)
      expect(flags[0]).toMatchObject({ kind: "gate_block" })
      expect(flags[0]?.detail).toMatchObject({ tool: "update_booking", p: 0.1 })
      expect(flags[0]?.reviewed_at).toBeNull()
      // And it is in the trace as well, so a run reads without a join.
      expect(captured.filter(([name]) => name === "flag_raised")).toHaveLength(1)
    })

    test("LEARN-1: a Confirm is not a flag, because asking is the system working", async () => {
      const { agent } = gated([change, { reply: "Shall I?" }], 0.55)
      await agent.receiveAndWait(hello())

      expect(await agent.store.flags.count()).toBe(0)
    })

    test("GATE-3: two Blocks in a row for the same person is a handover trigger", async () => {
      // Across turns, not within one: the Spec says for the same person,
      // and a person refused twice has been failed twice whether or not it
      // happened in one breath.
      const { agent } = gated(
        [change, { reply: "I cannot." }, change, { reply: "I still cannot." }],
        0.1,
      )

      const first = await agent.receiveAndWait(hello())
      expect(first.turn?.handoverDue).toEqual([])

      const second = await agent.receiveAndWait(hello({ channelMessageId: "msg-2" }))
      expect(second.turn?.handoverDue).toEqual(["gate_block_repeat"])
    })

    test("GATE-3: a call that passed in between breaks the run", async () => {
      const brain = scriptedBrain([
        change,
        { reply: "no" },
        change,
        { reply: "yes" },
        change,
        { reply: "no again" },
      ])
      // Block, then pass, then block. Two requests per turn: LOOP-8
      // step 1 asks `wants_human` before the brain is called at all,
      // and the gate asks its own once there is a call to judge.
      const decisions = scriptedDecisionModel(
        [0.1, 0.9, 0.1].flatMap((p) => [
          { [WANTS_HUMAN]: yesno(0) },
          { [GATE_QUESTION]: yesno(p) },
        ]),
      )
      sender = fakeSender()
      const agent = createAgent({
        config: config(),
        deps: { brains: [brain], decisionModel: decisions, db: localSupabase(), sender, clock },
        prompt: PROMPT,
        tools: [checkAvailability, updateBooking],
      })

      await agent.receiveAndWait(hello())
      await agent.receiveAndWait(hello({ channelMessageId: "msg-2" }))
      const third = await agent.receiveAndWait(hello({ channelMessageId: "msg-3" }))

      expect(third.turn?.handoverDue).toEqual([])
    })

    test("GATE-3: two routing picks below the threshold in a row is the other trigger", async () => {
      // Six tools, so routing runs, and a spread with nothing much behind
      // the winner, so the pick is below the 0.6 threshold.
      const brain = scriptedBrain([{ reply: "one" }, { reply: "two" }])
      const unsure = scriptedDecisionModel([
        { tool: choice("look_up_one", { look_up_one: 0.3, look_up_two: 0.3, no_tool: 0.4 }, 0.3) },
      ])
      sender = fakeSender()
      const agent = createAgent({
        config: config(),
        deps: { brains: [brain], decisionModel: unsure, db: localSupabase(), sender, clock },
        prompt: PROMPT,
        tools: six(),
      })

      const first = await agent.receiveAndWait(hello())
      expect(first.turn?.routed[0]?.reason).toBe("below_threshold")
      expect(first.turn?.handoverDue).toEqual([])

      const second = await agent.receiveAndWait(hello({ channelMessageId: "msg-2" }))
      expect(second.turn?.handoverDue).toEqual(["low_confidence_repeat"])

      // LEARN-1: each of them raised a low_confidence flag, and the
      // second one opened a handover, which is a flag of its own
      // (section 17: any handover starts).
      const flags = await agent.store.flags.list({}, { orderBy: "seq" })
      expect(flags.map((flag) => flag.kind)).toEqual([
        "low_confidence",
        "low_confidence",
        "handover",
      ])
      expect(flags[0]?.detail).toMatchObject({ choice: "look_up_one", threshold: 0.6 })
    })

    test("DATA-2: a routing decision is recorded whatever it decided", async () => {
      const brain = scriptedBrain([{ reply: "hi" }])
      const sure = scriptedDecisionModel([
        { tool: choice("look_up_one", { look_up_one: 0.95, no_tool: 0.05 }) },
      ])
      sender = fakeSender()
      const agent = createAgent({
        config: config(),
        deps: { brains: [brain], decisionModel: sure, db: localSupabase(), sender, clock },
        prompt: PROMPT,
        tools: six(),
      })

      await agent.receiveAndWait(hello())

      const decided = await agent.store.decisions.list({ kind: "route" }, { orderBy: "seq" })
      expect(decided).toHaveLength(1)
      expect(decided[0]).toMatchObject({ outcome: "top_pick", step: 1 })
      expect(decided[0]?.answers).toMatchObject({ tool: { choice: "look_up_one" } })
    })
  })

  test("CFG-1: an irreversible tool with no confirmSummary stops the agent starting", () => {
    // defineTool refuses this, so the only way to reach createAgent's check
    // is a tool built around it, as a hand written adapter might.
    const unsafe = { ...bookTable, confirmSummary: undefined } as unknown as Tool

    expect(() =>
      createAgent({
        config: config(),
        deps: {
          decisionModel: scriptedDecisionModel([]),
          brains: [scriptedBrain([])],
          db: localSupabase(),
          sender: fakeSender(),
          clock,
        },
        prompt: PROMPT,
        tools: [unsafe],
      }),
    ).toThrow(/confirmSummary/)
  })
})
