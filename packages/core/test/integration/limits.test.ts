// LIMIT-1 to LIMIT-3, LOOP-9 and LOOP-12: the four ways a turn ends
// without the agent having said what it wanted to say.
//
// They protect different people. The rate limit protects the agent from
// one person, the spend cap protects the builder from the agent, and the
// step cap and the brain outage protect the person from being left with
// nothing. Each one ends with a fixed line and a colleague being told,
// because every one of them is the agent saying "not now".
//
// The spend cap is the one worth being careful about. A cap that reads low
// does not stop anything, so the tests here are written around the two
// ways it reads low: a cost the provider did not report, and an increment
// lost between two processes.
import { test, expect, describe, beforeAll, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { migrate } from "../../src/migrate/index.ts"
import { replyKey, type Agent, type AgentOptions } from "../../src/runtime/index.ts"
import {
  costOf,
  BRAINS_FAILED_REPLY,
  RATE_LIMIT_REPLY,
  STEP_CAP_REPLY,
} from "../../src/runtime/limits.ts"
import { PERSON_TOLD, WANTS_HUMAN } from "../../src/runtime/handover.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool } from "../../src/tools/index.ts"
import {
  scriptedBrain,
  type ScriptedBrain,
  type ScriptedStep,
} from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import type { BrainOutput } from "../../src/providers/brains/types.ts"
import type { PersonRow } from "../../src/store/index.ts"

const PROMPT = "You are the host at a restaurant."
/** Monday, 11:30 in Asia/Kolkata. */
const NOW = "2026-10-19T06:00:00Z"

const agents = trackAgents("limits.test.ts")

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: [["11:00", "23:00"]] },
    brain: { id: "openrouter", model: "test/model" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { messagesPerWindow: 2, windowMinutes: 10, dailySpendUsd: 1 },
    notice: "We store your messages.",
    retentionDays: 365,
    burstWindowMs: 0,
    workerPollMs: 25,
    ...over,
  })
}

/** A brain answer with the usage a test wants to assert on. */
const answers = (text: string, usage: Record<string, number>): ScriptedStep => ({
  output: {
    text,
    finishReason: "stop",
    usage: usage as unknown as BrainOutput["usage"],
  },
})

/** A read tool, so a brain can loop without the gate getting involved. */
const lookUp = defineTool({
  name: "look_up",
  description: "Looks something up.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask anything"], dontCallWhen: ["never"] },
  examples: { should: ["any space?"], shouldNot: ["hello"] },
  handler: async () => ({ ok: true }),
})

describeDatabase("limits", (sql) => {
  const clock = fixedClock(NOW)
  let sender: FakeSender

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
    clock.set(NOW)
  })

  interface Built {
    agent: Agent
    brain: ScriptedBrain
  }

  function agentWith(
    script: ScriptedStep[] = [{ reply: "We open at 11." }],
    over: Record<string, unknown> = {},
    options: { tools?: boolean; start?: boolean } = {},
  ): Built {
    const brain = scriptedBrain(script, { exhaustedReply: "Anything else?" })
    sender = fakeSender()
    const build: AgentOptions = {
      config: config(over),
      deps: {
        brains: [brain],
        decisionModel: scriptedDecisionModel([
          { [WANTS_HUMAN]: yesno(0), [GATE_QUESTION]: yesno(1) },
        ]),
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: PROMPT,
      tools: options.tools === true ? [lookUp] : [],
    }
    const agent = options.start === false ? agents.build(build) : agents.create(build)
    return { agent, brain }
  }

  const from = (text: string, id = `m-${text.slice(0, 8)}-${Math.random()}`) => ({
    channel: "whatsapp",
    channelUserId: "9",
    channelMessageId: id,
    text,
  })

  const operator = (agent: Agent, id = "op-1"): Promise<PersonRow> =>
    agent.store.people.insert({
      channel: "whatsapp",
      channel_user_id: id,
      role: "operator",
      display_name: "Ravi",
    })

  /**
   * Messages this person has already sent inside the window.
   *
   * Written straight to the inbox as handled rows, because what LIMIT-1
   * counts is what arrived, and twenty real turns would take twenty brain
   * calls to prove something about the twenty first.
   */
  async function alreadySent(agent: Agent, who: PersonRow, howMany: number): Promise<void> {
    for (let n = 0; n < howMany; n++) {
      await agent.store.inbox.insert({
        person_id: who.id,
        channel_message_id: `old-${n}-${Math.random()}`,
        text: "hello",
        status: "done",
        received_at: clock.now().toISOString(),
      })
    }
  }

  const personOf = async (agent: Agent): Promise<PersonRow> =>
    (await agent.store.people.list({ role: "end_user" }))[0] as PersonRow

  describe("LIMIT-1: the rate limit", () => {
    test("LIMIT-1: under the limit the turn is answered as usual", async () => {
      const { agent, brain } = agentWith()
      const who = await agent.store.people.insert({ channel: "whatsapp", channel_user_id: "9" })
      await alreadySent(agent, who, 1)

      await agent.receiveAndWait(from("what time do you open?"))

      expect(sender.texts()).toEqual(["We open at 11."])
      expect(brain.calls).toHaveLength(1)
    })

    test("LIMIT-1: over the limit the person gets one fixed reply, and it costs nothing", async () => {
      const { agent, brain } = agentWith()
      const who = await agent.store.people.insert({ channel: "whatsapp", channel_user_id: "9" })
      await alreadySent(agent, who, 2)

      const result = await agent.receiveAndWait(from("hello? hello?"))

      expect(result.turn?.outcome).toBe("rate_limited")
      expect(sender.texts()).toEqual([RATE_LIMIT_REPLY])
      // A flood has to be cheap, or the limit is a way to spend money.
      expect(brain.calls).toHaveLength(0)
      expect(await agent.store.decisions.count()).toBe(0)
      // Handled, not failed: the rule answered it, so the recovery sweep
      // must leave it alone.
      expect((await agent.store.inbox.byId(result.inboxId))?.status).toBe("done")
    })

    test("LIMIT-1: the next message in the same window gets silence", async () => {
      const { agent } = agentWith()
      const who = await agent.store.people.insert({ channel: "whatsapp", channel_user_id: "9" })
      await alreadySent(agent, who, 2)

      await agent.receiveAndWait(from("hello?"))
      sender.reset()
      const result = await agent.receiveAndWait(from("anyone there?"))

      expect(result.turn?.outcome).toBe("rate_limited")
      expect(sender.texts()).toEqual([])
    })

    test("LIMIT-1: once the window has passed they are answered again", async () => {
      const { agent } = agentWith()
      const who = await agent.store.people.insert({ channel: "whatsapp", channel_user_id: "9" })
      await alreadySent(agent, who, 2)
      await agent.receiveAndWait(from("hello?"))
      sender.reset()

      clock.advance(11 * 60_000)
      await agent.receiveAndWait(from("what time do you open?"))

      expect(sender.texts()).toEqual(["We open at 11."])
    })

    test("LIMIT-1: the operators are told once, not once per message", async () => {
      const { agent } = agentWith()
      await operator(agent)
      const who = await agent.store.people.insert({ channel: "whatsapp", channel_user_id: "9" })
      await alreadySent(agent, who, 2)

      await agent.receiveAndWait(from("hello?"))
      await agent.receiveAndWait(from("hello??"))
      await agent.settled()

      const alerts = await agent.store.outbox.list({ kind: "operator_alert" })
      expect(alerts).toHaveLength(1)
      expect(JSON.stringify(alerts[0]?.payload)).toContain("rate limit")
      // No handover: nobody should be handed a conversation with
      // somebody flooding them.
      expect(await agent.store.handovers.count()).toBe(0)
    })

    test("LIMIT-1: an operator is not rate limited", async () => {
      // Their channel is the control channel. An operator who could be
      // silenced by their own messages would have no way left to say
      // `resume`.
      const { agent, brain } = agentWith()
      const who = await operator(agent, "9")
      await alreadySent(agent, who, 5)

      await agent.receiveAndWait(from("/status"))

      expect(brain.calls).toHaveLength(1)
      expect(sender.texts()).not.toEqual([RATE_LIMIT_REPLY])
    })
  })

  describe("LIMIT-3: the spend cap", () => {
    test("LIMIT-3: what a turn cost joins today's total", async () => {
      const { agent } = agentWith([
        answers("We open at 11.", { inputTokens: 100, outputTokens: 10, costUsd: 0.002 }),
      ])

      await agent.receiveAndWait(from("what time do you open?"))

      const [row] = await agent.store.spend.list()
      expect(row?.day).toBe("2026-10-19")
      expect(Number(row?.usd)).toBeCloseTo(0.002, 6)
      expect(row?.calls).toBe(1)
      expect((await agent.limits.spent()).over).toBe(false)
    })

    test("LIMIT-3: the pricing table is used when the provider reports no cost", async () => {
      // The case K9 is about: a route that bills per token and says
      // nothing about it. Without the table, spend reads zero for ever.
      const { agent } = agentWith(
        [answers("We open at 11.", { inputTokens: 1_000_000, outputTokens: 500_000 })],
        { pricing: { "test/model": { inputPerM: 0.5, outputPerM: 1.5 } } },
      )

      await agent.receiveAndWait(from("what time do you open?"))

      const [row] = await agent.store.spend.list()
      expect(Number(row?.usd)).toBeCloseTo(0.5 + 0.75, 6)
    })

    test("LIMIT-3: a model the pricing table does not list costs nothing, rather than a guess", async () => {
      const { agent } = agentWith([answers("We open at 11.", { inputTokens: 1_000_000 })])

      await agent.receiveAndWait(from("what time do you open?"))

      expect(await agent.store.spend.count()).toBe(0)
      expect((await agent.limits.spent()).usd).toBe(0)
    })

    test("LIMIT-3: at the cap, the next turn is a handover and costs nothing", async () => {
      const { agent, brain } = agentWith()
      await agent.limits.add(1.5)

      const result = await agent.receiveAndWait(from("what time do you open?"))

      expect(result.turn?.outcome).toBe("handover")
      expect(brain.calls).toHaveLength(0)
      expect(sender.texts()).toEqual([PERSON_TOLD])
      const [handover] = await agent.store.handovers.list()
      expect(handover?.reason).toBe("spend_cap")
      // No summary: at the cap, spending more is the one thing that
      // must not happen.
      expect(handover?.summary).toBeNull()
      const hit = await agent.store.events.find({ name: "limit_hit" })
      expect(hit?.props).toMatchObject({ limit: "spend" })
    })

    test("LIMIT-3: the cap is read per day in the agent's timezone", async () => {
      const { agent } = agentWith()
      await agent.limits.add(1.5)
      expect((await agent.limits.spent()).over).toBe(true)

      // 18:40 UTC is 00:10 the next day in Asia/Kolkata.
      clock.set(new Date("2026-10-19T18:40:00Z"))

      expect(agent.limits.today()).toBe("2026-10-20")
      expect((await agent.limits.spent()).over).toBe(false)
      await agent.receiveAndWait(from("what time do you open?"))
      expect(sender.texts()).toEqual(["We open at 11."])
    })

    test("LIMIT-3: the handover summary call is counted too", async () => {
      // HAND-2's three lines are the one brain call outside a turn, so
      // nothing else would ever add them up.
      const { agent } = agentWith([
        { tool: "escalate", input: { why: "they asked for a manager" } },
        answers("Someone will be with you.", { inputTokens: 10, outputTokens: 5, costUsd: 0.001 }),
      ])
      await agent.receiveAndWait(from("get me a manager"))
      await agent.settled()

      const started = await agent.store.events.find({ name: "handover_started" })
      const summaryCost = Number((started?.props as { costUsd?: number }).costUsd ?? 0)
      expect(summaryCost).toBeGreaterThan(0)

      const [row] = await agent.store.spend.list()
      const turn = (await agent.store.turns.list())[0]
      expect(Number(row?.usd)).toBeCloseTo(Number(turn?.cost_usd) + summaryCost, 6)
    })

    test("LIMIT-3: two processes adding at once lose nothing", async () => {
      // The reason the total is claimed rather than written. Two servers
      // reading 0.10 and both writing 0.11 would lose a turn's cost
      // every time they overlapped, and a cap that reads low is not a
      // cap.
      const { agent } = agentWith([], {}, { start: false })
      const second = agentWith([], {}, { start: false })

      const adds = [
        ...Array.from({ length: 10 }, () => agent.limits.add(0.01)),
        ...Array.from({ length: 10 }, () => second.agent.limits.add(0.01)),
      ]
      const results = await Promise.all(adds)

      expect(results.every((total) => total !== null)).toBe(true)
      const [row] = await agent.store.spend.list()
      expect(Number(row?.usd)).toBeCloseTo(0.2, 6)
      expect(row?.calls).toBe(20)
    })

    test("LIMIT-3: the rate limit is read before the spend cap", async () => {
      // LOOP-5's order. Over both, the cheaper rule decides, and nobody
      // is handed a conversation with somebody flooding them.
      const { agent } = agentWith()
      await agent.limits.add(1.5)
      const who = await agent.store.people.insert({ channel: "whatsapp", channel_user_id: "9" })
      await alreadySent(agent, who, 2)

      const result = await agent.receiveAndWait(from("hello?"))

      expect(result.turn?.outcome).toBe("rate_limited")
      expect(await agent.store.handovers.count()).toBe(0)
    })
  })

  describe("LOOP-9 and LOOP-12: a turn that answered nobody", () => {
    test("LIMIT-2 and LOOP-9: the step cap tells the person, flags the turn and hands over", async () => {
      const { agent } = agentWith(
        [{ tool: "look_up" }, { tool: "look_up" }, { tool: "look_up" }],
        { maxSteps: 2 },
        { tools: true },
      )
      await operator(agent)

      const result = await agent.receiveAndWait(from("any space on monday?"))
      await agent.settled()

      expect(result.turn?.outcome).toBe("step_cap")
      expect(sender.texts()).toContain(STEP_CAP_REPLY)
      const [flag] = await agent.store.flags.list({ kind: "step_cap" })
      expect(flag?.detail).toMatchObject({ maxSteps: 2 })
      const [handover] = await agent.store.handovers.list()
      expect(handover?.reason).toBe("step_cap")
      // LOOP-9: and an operator is told, which the handover does.
      expect(await agent.store.outbox.count({ kind: "operator_alert" })).toBe(1)
    })

    test("LOOP-9: the holding message is keyed by the messages, not by the turn", async () => {
      // A turn abandoned by a dying process has its messages handed back
      // (JOB-3), and the turn that answers them is a different turn.
      // Keyed by the turn, both holding messages would go out and the
      // person would be told twice. Keyed by what is being answered, the
      // outbox keeps the first.
      //
      // Asserted on the key rather than by running the sweep: the first
      // turn opens a handover, so a second turn over the same messages
      // forwards them to a colleague instead of reaching the step cap
      // again (LOOP-5 step 5). The key is what carries the guarantee.
      const { agent } = agentWith(
        [{ tool: "look_up" }, { tool: "look_up" }, { tool: "look_up" }],
        { maxSteps: 2 },
        { tools: true },
      )

      const result = await agent.receiveAndWait(from("any space on monday?"))
      await agent.settled()

      const rows = await agent.store.outbox.list({ kind: "reply" })
      const holding = rows.find((row) => (row.payload as { text?: string }).text === STEP_CAP_REPLY)
      expect(holding?.idempotency_key).toBe(replyKey([result.inboxId]))
    })

    test("LOOP-12: every brain failing tells the person and alerts an operator", async () => {
      const { agent } = agentWith([{ throws: "the model is down", retryable: true }])
      await operator(agent)

      const result = await agent.receiveAndWait(from("what time do you open?"))
      await agent.settled()

      expect(result.turn?.outcome).toBe("brains_failed")
      // The person's two, in order. The operator's alert is on the same
      // fake channel, so it is read from the outbox below rather than
      // from this list.
      expect(sender.texts().slice(0, 2)).toEqual([BRAINS_FAILED_REPLY, PERSON_TOLD])
      const [handover] = await agent.store.handovers.list()
      expect(handover?.reason).toBe("brains_failed")
      const alerts = await agent.store.outbox.list({ kind: "operator_alert" })
      expect(JSON.stringify(alerts[0]?.payload)).toContain("could not answer at all")
    })
  })

  describe("LIMIT-3: pricing on its own", () => {
    const priced = config({ pricing: { "test/model": { inputPerM: 2, outputPerM: 6 } } })

    test("LIMIT-3: a reported cost wins over the table", () => {
      const usd = costOf(priced, "test/model", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        costUsd: 0.5,
      })
      expect(usd).toBe(0.5)
    })

    test("LIMIT-3: with no reported cost the table prices the tokens", () => {
      const usd = costOf(priced, "test/model", { inputTokens: 500_000, outputTokens: 100_000 })
      expect(usd).toBeCloseTo(1 + 0.6, 6)
    })

    test("LIMIT-3: a zero cost is a cost, not a missing one", () => {
      // A free tier reports 0, and the table must not be consulted for a
      // number the provider has already answered.
      const usd = costOf(priced, "test/model", { inputTokens: 1_000_000, costUsd: 0 })
      expect(usd).toBe(0)
    })
  })
})
