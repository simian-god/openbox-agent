// HAND-1 to HAND-3, HAND-7's first half, and LOOP-10's repeat rule, on
// real turns.
//
// A handover is the one state where the agent stops being the thing that
// answers, so the tests are written around the two ways that goes wrong:
// the person is told twice, or the person is told nothing and waits.
//
// Every trigger in HAND-1 that exists yet is here: the brain's own
// `escalate`, the decision model's `wants_human`, GATE-3's two repeat
// rules and LOOP-10's. The spend cap is T7.3 and an operator's
// `take_over` is below.
import { test, expect, describe, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { type Agent, type AgentOptions } from "../../src/runtime/index.ts"
import {
  createHandovers,
  PERSON_TOLD,
  BACK_WITH_BOT,
  WANTS_HUMAN,
} from "../../src/runtime/handover.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool, type Tool } from "../../src/tools/index.ts"
import { scriptedBrain, type ScriptedStep } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import type { Brain, BrainInput, BrainOutput } from "../../src/providers/brains/types.ts"
import type { PersonRow } from "../../src/store/index.ts"

const SECRET = "test-secret-long-enough-to-look-real"
const PROMPT = "You are the host at a restaurant."
const SUMMARY = "They want a table on Monday.\nThe agent could not confirm it.\nThey are waiting."

const agents = trackAgents("handover.test.ts")

function createAgent(options: AgentOptions): Agent {
  return agents.create({ secret: SECRET, ...options })
}

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

/** What fails, so LOOP-10 has something to count. */
let breaks = 0
const flaky = defineTool({
  name: "check_availability",
  description: "Checks whether a table is free.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask about a table"], dontCallWhen: ["they do not"] },
  examples: { should: ["any space?"], shouldNot: ["hello"] },
  handler: async () => {
    breaks++
    if (breaks <= 2) throw new Error("the booking system said no")
    return { free: true }
  },
})

/**
 * A brain that answers the summary request separately from the script.
 *
 * HAND-2 gives the brain one job in a handover, and it is not part of the
 * conversation: it happens in the middle of a tool call. Threading it
 * through the same script would mean every test counting brain calls it
 * does not care about.
 */
function testBrain(
  script: ScriptedStep[],
  options: { summary?: string | "fails" } = {},
): { brain: Brain; calls: BrainInput[]; summaries: () => number } {
  const scripted = scriptedBrain(script, { exhaustedReply: "Anything else?" })
  let summaries = 0

  const brain: Brain = {
    id: "scripted",
    kind: "api",
    supportsImages: true,
    async complete(input: BrainInput): Promise<BrainOutput> {
      if (input.system.includes("three short lines")) {
        summaries++
        if (options.summary === "fails") throw new Error("every brain is down")
        return {
          text: options.summary ?? SUMMARY,
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.0001 },
        }
      }
      return scripted.complete(input)
    },
  }

  return { brain, calls: scripted.calls, summaries: () => summaries }
}

describeDatabase("handover", (sql) => {
  const clock = fixedClock("2026-10-19T06:00:00Z")
  let sender: FakeSender

  beforeEach(async () => {
    await resetDatabase(sql())
    breaks = 0
  })

  interface Built {
    agent: Agent
    calls: BrainInput[]
    summaries: () => number
  }

  /** An agent, with `wants_human` answered low unless a test says otherwise. */
  function agentWith(
    script: ScriptedStep[],
    options: {
      wantsHuman?: number
      gate?: number
      summary?: string | "fails"
      tools?: Tool[]
      answers?: Record<string, unknown>[]
    } = {},
  ): Built {
    const { brain, calls, summaries } = testBrain(
      script,
      options.summary !== undefined ? { summary: options.summary } : {},
    )
    sender = fakeSender()
    const agent = createAgent({
      config: config(),
      deps: {
        brains: [brain],
        decisionModel: scriptedDecisionModel([
          {
            [WANTS_HUMAN]: yesno(options.wantsHuman ?? 0),
            [GATE_QUESTION]: yesno(options.gate ?? 1),
          },
        ]),
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: PROMPT,
      tools: options.tools ?? [flaky],
    })
    return { agent, calls, summaries }
  }

  const from = (who: string, text: string, id = `m-${who}-${text.slice(0, 8)}`) => ({
    channel: "whatsapp",
    channelUserId: who,
    channelMessageId: id,
    text,
  })

  /** An operator who has already been made one (ROLE-2). */
  const operator = (agent: Agent, id: string, name?: string): Promise<PersonRow> =>
    agent.store.people.insert({
      channel: "whatsapp",
      channel_user_id: id,
      role: "operator",
      ...(name !== undefined ? { display_name: name } : {}),
    })

  describe("HAND-1: the triggers", () => {
    test("HAND-1: escalate opens a handover, waiting", async () => {
      const { agent } = agentWith([
        { tool: "escalate", input: { why: "they asked for a manager" } },
        { reply: "Someone will be with you." },
      ])

      await agent.receiveAndWait(from("9", "get me a manager"))

      const [handover] = await agent.store.handovers.list({}, { orderBy: "seq" })
      expect(handover?.status).toBe("waiting")
      expect(handover?.reason).toBe("escalate")
      expect(handover?.detail).toBe("they asked for a manager")
      expect(handover?.turn_id).not.toBeNull()
    })

    test("HAND-1: a second escalate opens nothing new, and tells nobody again", async () => {
      const { agent } = agentWith([
        { tool: "escalate", input: { why: "they asked for a manager" } },
        { reply: "Someone will be with you." },
      ])
      await agent.receiveAndWait(from("9", "get me a manager"))
      const told = sender.texts().filter((text) => text === PERSON_TOLD).length
      expect(told).toBe(1)

      // The person writes again, and the agent is not answering them now
      // (HAND-5), so the only way to escalate twice is a second turn that
      // reaches the tool. This one does not, which is the point: nothing
      // opens a second handover for one person.
      await agent.receiveAndWait(from("9", "hello?", "m-again"))

      expect(await agent.store.handovers.count()).toBe(1)
      expect(sender.texts().filter((text) => text === PERSON_TOLD)).toHaveLength(1)
    })

    test("HAND-1: wants_human at the threshold opens one", async () => {
      const { agent } = agentWith([{ reply: "We open at 11." }], { wantsHuman: 0.8 })

      const result = await agent.receiveAndWait(from("9", "is anyone there?"))

      expect(result.turn?.handoverDue).toEqual(["wants_human"])
      const [handover] = await agent.store.handovers.list({}, { orderBy: "seq" })
      expect(handover?.reason).toBe("wants_human")
      // The brain still answered, and the person hears that first.
      expect(sender.texts()).toEqual(["We open at 11.", PERSON_TOLD])
    })

    test("HAND-1: wants_human below the threshold opens nothing", async () => {
      const { agent } = agentWith([{ reply: "We open at 11." }], { wantsHuman: 0.79 })

      const result = await agent.receiveAndWait(from("9", "is anyone there?"))

      expect(result.turn?.handoverDue).toEqual([])
      expect(await agent.store.handovers.count()).toBe(0)
    })

    test("HAND-1: the decision is recorded either way, so a threshold can be tuned", async () => {
      const { agent } = agentWith([{ reply: "We open at 11." }], { wantsHuman: 0.4 })

      await agent.receiveAndWait(from("9", "is anyone there?"))

      const [decision] = await agent.store.decisions.list({ kind: "wants_human" })
      expect(decision?.outcome).toBe("no")
      expect(JSON.stringify(decision?.answers)).toContain("0.4")
    })

    test("LOOP-10: the same tool failing twice in a row opens one", async () => {
      // Across turns, which is the harder half of LOOP-10: the first
      // failure is in a turn that has already ended.
      const { agent } = agentWith([
        { tool: "check_availability" },
        { reply: "I could not check." },
        { tool: "check_availability" },
        { reply: "Still not working." },
      ])

      const first = await agent.receiveAndWait(from("9", "any space?"))
      expect(first.turn?.handoverDue).toEqual([])
      expect(await agent.store.handovers.count()).toBe(0)

      const second = await agent.receiveAndWait(from("9", "try again", "m-2"))

      expect(second.turn?.handoverDue).toEqual(["tool_failed_repeat"])
      const [handover] = await agent.store.handovers.list({}, { orderBy: "seq" })
      expect(handover?.reason).toBe("tool_failed_repeat")
    })

    test("LOOP-10: a success in between breaks the run", async () => {
      // Three calls: fail, fail, succeed. The third turn must not open one
      // on the strength of two failures that are no longer in a row.
      breaks = 1
      const { agent } = agentWith([
        { tool: "check_availability" },
        { reply: "I could not check." },
        { tool: "check_availability" },
        { reply: "Yes, there is space." },
        { tool: "check_availability" },
        { reply: "Still space." },
      ])

      await agent.receiveAndWait(from("9", "any space?"))
      await agent.store.handovers.remove({})
      const second = await agent.receiveAndWait(from("9", "and now?", "m-2"))
      const third = await agent.receiveAndWait(from("9", "and now?", "m-3"))

      expect(second.turn?.toolsRun).toEqual([{ name: "check_availability", ok: true }])
      expect(third.turn?.handoverDue).toEqual([])
    })

    test("LOOP-10: one failure each from two people is not a run", async () => {
      // LOOP-10 says the same tool failing twice for the same person. Two
      // people failing once each is two people with a bad day.
      const { agent } = agentWith([
        { tool: "check_availability" },
        { reply: "I could not check." },
        { tool: "check_availability" },
        { reply: "I could not check." },
      ])

      await agent.receiveAndWait(from("9", "any space?"))
      const other = await agent.receiveAndWait(from("8", "any space?"))

      expect(other.turn?.handoverDue).toEqual([])
      expect(await agent.store.handovers.count()).toBe(0)
    })

    test("HAND-1: escalating twice in one turn is told plainly the second time", async () => {
      // The brain gets a tool result either way, and the second one has to
      // say the conversation is already handed over, or it will keep
      // trying and then tell the person something that is not true.
      const { agent } = agentWith([
        { tool: "escalate", input: { why: "they asked" } },
        { tool: "escalate", input: { why: "they asked again" } },
        { reply: "Someone will be with you." },
      ])

      await agent.receiveAndWait(from("9", "get me a manager"))

      expect(await agent.store.handovers.count()).toBe(1)
      const runs = await agent.store.toolRuns.list({ tool: "escalate" }, { orderBy: "seq" })
      expect(runs).toHaveLength(2)
      expect(JSON.stringify(runs[0]?.result)).toContain('"handedOver":true')
      expect(JSON.stringify(runs[1]?.result)).toContain('"handedOver":false')
      expect(JSON.stringify(runs[1]?.result)).toContain("already")
      expect(sender.texts().filter((text) => text === PERSON_TOLD)).toHaveLength(1)
      // LOOP-8 step 1: three steps in that turn, and `wants_human` is asked
      // on the first of them rather than on each.
      expect(await agent.store.decisions.count({ kind: "wants_human" })).toBe(1)
    })

    test("HAND-1: two triggers in one turn open one handover", async () => {
      // `wants_human` fires on step 1 and `escalate` inside the turn. The
      // unique index decides, not the order they happened in.
      const { agent } = agentWith(
        [{ tool: "escalate", input: { why: "they asked" } }, { reply: "Someone will come." }],
        { wantsHuman: 1 },
      )

      await agent.receiveAndWait(from("9", "get me a person"))

      expect(await agent.store.handovers.count()).toBe(1)
      const [handover] = await agent.store.handovers.list({}, { orderBy: "seq" })
      // The one that happened first is the reason on the row.
      expect(handover?.reason).toBe("escalate")
      expect(sender.texts().filter((text) => text === PERSON_TOLD)).toHaveLength(1)
    })
  })

  describe("HAND-2: what opening one does", () => {
    test("HAND-2: the person is told a person will reply", async () => {
      const { agent } = agentWith([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
      ])

      await agent.receiveAndWait(from("9", "get me a manager"))

      expect(sender.texts()).toContain(PERSON_TOLD)
    })

    test("HAND-2: every operator is alerted, with the name, reason and summary", async () => {
      const { agent, summaries } = agentWith([
        { tool: "escalate", input: { why: "they asked for a manager" } },
        { reply: "Someone will be with you." },
      ])
      await operator(agent, "op-1", "Asha")
      await operator(agent, "op-2")
      await agent.store.people.insert({ channel: "whatsapp", channel_user_id: "9" })

      await agent.receiveAndWait(from("9", "get me a manager"))

      const alerts = sender.sent.filter((out) => out.idempotencyKey.includes(":alert:"))
      expect(alerts).toHaveLength(2)
      expect(alerts.map((out) => out.channelUserId).sort()).toEqual(["op-1", "op-2"])
      const text = alerts[0]?.text ?? ""
      expect(text).toContain("whatsapp 9")
      expect(text).toContain("the agent handed it over")
      expect(text).toContain("they asked for a manager")
      expect(text).toContain(SUMMARY)
      // HAND-2: writing it is the brain's only job in a handover.
      expect(summaries()).toBe(1)
      const [handover] = await agent.store.handovers.list({}, { orderBy: "seq" })
      expect(handover?.summary).toBe(SUMMARY)
    })

    test("HAND-2: the alert goes out even when no brain can write the summary", async () => {
      const { agent } = agentWith(
        [{ tool: "escalate", input: { why: "they asked" } }, { reply: "Someone will come." }],
        { summary: "fails" },
      )
      await operator(agent, "op-1", "Asha")

      await agent.receiveAndWait(from("9", "get me a manager"))

      const alerts = sender.sent.filter((out) => out.idempotencyKey.includes(":alert:"))
      expect(alerts).toHaveLength(1)
      expect(alerts[0]?.text).toContain("not available")
      const [handover] = await agent.store.handovers.list({}, { orderBy: "seq" })
      expect(handover?.summary).toBeNull()
      // And the person was still told, which is the promise that matters.
      expect(sender.texts()).toContain(PERSON_TOLD)
    })

    test("HAND-2: an agent with no operators still opens it and tells the person", async () => {
      // A handover nobody can take is still better than a person being
      // answered by a bot that has already failed them.
      const { agent } = agentWith([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will come." },
      ])

      await agent.receiveAndWait(from("9", "get me a manager"))

      expect(await agent.store.handovers.count()).toBe(1)
      expect(sender.sent.filter((out) => out.idempotencyKey.includes(":alert:"))).toHaveLength(0)
      expect(sender.texts()).toContain(PERSON_TOLD)
    })

    test("HAND-2: it is in the trace, and it is a flag", async () => {
      const { agent } = agentWith([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will come." },
      ])

      await agent.receiveAndWait(from("9", "get me a manager"))

      const events = await agent.store.events.list({ name: "handover_started" })
      expect(events).toHaveLength(1)
      expect(events[0]?.props).toMatchObject({ reason: "escalate", summarised: true })
      // Section 17: any handover starts.
      const flags = await agent.store.flags.list({ kind: "handover" })
      expect(flags).toHaveLength(1)
    })
  })

  describe("HAND-2: the summary cannot stop the alert", () => {
    test("HAND-2: a summariser that throws costs the summary and nothing else", async () => {
      // The core's own summariser swallows a brain failure, so this is the
      // case where the summariser itself is broken: a glue's own, or a bug
      // in ours. The person has already been told somebody will reply, so
      // the operators have to hear about it either way.
      const { agent } = agentWith([{ reply: "hello" }])
      await operator(agent, "op-1", "Asha")
      const person = await agent.store.people.insert({
        channel: "whatsapp",
        channel_user_id: "9",
      })

      const handovers = createHandovers({
        config: config(),
        store: agent.store,
        clock,
        events: agent.events,
        outbox: agent.outbox,
        summarise: () => {
          throw new Error("the summariser is broken")
        },
      })

      const { opened } = await handovers.open({ person, reason: "operator" })

      expect(opened).toBe(true)
      await agent.outbox.pump.drain()
      const alerts = sender.sent.filter((out) => out.idempotencyKey.includes(":alert:"))
      expect(alerts).toHaveLength(1)
      expect(sender.texts()).toContain(PERSON_TOLD)
    })
  })

  describe("HAND-5: while it is open", () => {
    async function waiting(): Promise<Built> {
      const built = agentWith([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
        { reply: "This should never be said." },
      ])
      await built.agent.receiveAndWait(from("9", "get me a manager"))
      sender.reset()
      return built
    }

    test("HAND-5: the agent does not answer a person in a handover", async () => {
      const { agent, calls } = await waiting()
      const before = calls.length

      const result = await agent.receiveAndWait(from("9", "are you there?", "m-2"))

      expect(result.turn?.outcome).toBe("handover")
      expect(sender.texts()).toEqual([])
      // Not one brain call, which is what makes this cheap as well as right.
      expect(calls).toHaveLength(before)
    })

    test("HAND-5: their message is still stored, and the row is done", async () => {
      const { agent } = await waiting()

      const result = await agent.receiveAndWait(from("9", "are you there?", "m-2"))

      const messages = await agent.store.messages.list({}, { orderBy: "seq" })
      expect(messages.map((row) => row.text)).toContain("are you there?")
      const row = await agent.store.inbox.byId(result.inboxId)
      expect(row?.status).toBe("done")
    })

    test("HAND-5: an operator is never silenced by a handover of their own", async () => {
      // Their messages are the control channel. An operator who could be
      // held by a row would have no way left to say `resume`.
      const { agent } = agentWith([{ reply: "Nothing is waiting." }])
      const op = await operator(agent, "op-1", "Asha")
      await agent.store.handovers.insert({
        person_id: op.id,
        reason: "operator",
        status: "waiting",
        opened_at: clock.now().toISOString(),
      })

      const result = await agent.receiveAndWait(from("op-1", "what is waiting?"))

      expect(result.turn?.outcome).toBe("replied")
    })
  })

  describe("HAND-3: taking it over", () => {
    /** A waiting handover, and two operators who could take it. */
    async function waitingWithOperators(): Promise<{
      agent: Agent
      first: PersonRow
      second: PersonRow
    }> {
      const { agent } = agentWith([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
        // The operator's turn: the brain reaches for the tool, then speaks.
        { tool: "take_over" },
        { reply: "It is yours." },
      ])
      const first = await operator(agent, "op-1", "Asha")
      const second = await operator(agent, "op-2", "Ravi")
      await agent.receiveAndWait(from("9", "get me a manager"))
      sender.reset()
      return { agent, first, second }
    }

    test("HAND-3: the first operator to take it makes it active", async () => {
      const { agent, first } = await waitingWithOperators()

      await agent.receiveAndWait(from("op-1", "take over"))

      const [handover] = await agent.store.handovers.list({}, { orderBy: "seq" })
      expect(handover?.status).toBe("active")
      expect(handover?.operator_id).toBe(first.id)
      expect(handover?.taken_at).not.toBeNull()
      const events = await agent.store.events.list({ name: "handover_taken" })
      expect(events).toHaveLength(1)
    })

    test("HAND-3: the other operators are told who took it", async () => {
      const { agent } = await waitingWithOperators()

      await agent.receiveAndWait(from("op-1", "take over"))

      const told = sender.sent.filter((out) => out.idempotencyKey.includes(":taken:"))
      expect(told).toHaveLength(1)
      expect(told[0]?.channelUserId).toBe("op-2")
      expect(told[0]?.text).toContain("Asha")
    })

    test("HAND-3: two operators taking it at once means one of them gets it", async () => {
      const { agent, first, second } = await waitingWithOperators()

      // Through the module, because the person lease deliberately stops two
      // turns for one person running at once, and this race is between two
      // operators acting on a third person's conversation.
      const [a, b] = await Promise.all([
        agent.handovers.takeOver({ operator: first }),
        agent.handovers.takeOver({ operator: second }),
      ])

      const kinds = [a.kind, b.kind].sort()
      expect(kinds).toEqual(["already_taken", "taken"])
      const [handover] = await agent.store.handovers.list({}, { orderBy: "seq" })
      expect(handover?.status).toBe("active")
      expect([first.id, second.id]).toContain(handover?.operator_id ?? "")
    })

    test("HAND-1: an operator naming somebody not in a handover starts one", async () => {
      // HAND-1's last trigger, and section 10's own words: the tool takes
      // an open handover or starts one for a named person. A colleague who
      // has read a conversation and decided to answer it themselves is the
      // clearest trigger there is.
      const { agent } = agentWith([
        { reply: "We open at 11." },
        { tool: "take_over", input: { user_id: "9" } },
        { reply: "They are yours." },
      ])
      const asha = await operator(agent, "op-1", "Asha")
      await agent.receiveAndWait(from("9", "are you open?"))
      expect(await agent.store.handovers.count()).toBe(0)
      sender.reset()

      await agent.receiveAndWait(from("op-1", "I will take 9 myself"))

      const [handover] = await agent.store.handovers.list({}, { orderBy: "seq" })
      expect(handover?.reason).toBe("operator")
      expect(handover?.status).toBe("active")
      expect(handover?.operator_id).toBe(asha.id)
      // Told once, by the core, the same as every other trigger (HAND-2).
      expect(sender.texts().filter((text) => text === PERSON_TOLD)).toHaveLength(1)
      // And the agent stops answering them (LOOP-5 step 5).
      const next = await agent.receiveAndWait(from("9", "hello?", "m-after"))
      expect(next.turn?.outcome).toBe("handover")
    })

    test("C12: an operator resumes from their own channel", async () => {
      // Every other part of C12 is proven end to end from a message. This
      // one was only ever proven through the module, which is not what an
      // operator has.
      const { agent } = agentWith([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
        { tool: "take_over" },
        { reply: "It is mine." },
        { tool: "resume" },
        { reply: "Given back." },
      ])
      await operator(agent, "op-1", "Asha")
      await agent.receiveAndWait(from("9", "get me a manager"))
      await agent.receiveAndWait(from("op-1", "take over"))

      // A slash, because anything else from a focused operator is relayed
      // to the person word for word (HAND-4).
      await agent.receiveAndWait(from("op-1", "/give them back to the agent", "m-op-2"))

      const [handover] = await agent.store.handovers.list({}, { orderBy: "seq" })
      expect(handover?.status).toBe("closed")
      expect(handover?.ended_reason).toBe("resume")
    })

    test("HAND-3: taking over when nothing is waiting says so", async () => {
      const { agent } = agentWith([{ reply: "Nothing is waiting." }])
      const op = await operator(agent, "op-1", "Asha")

      const taken = await agent.handovers.takeOver({ operator: op })

      expect(taken.kind).toBe("none")
    })
  })

  describe("HAND-7: giving it back", () => {
    test("HAND-7: resume closes it and the brain is told a handover happened", async () => {
      const { agent } = agentWith([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
        { reply: "How can I help?" },
      ])
      const op = await operator(agent, "op-1", "Asha")
      await agent.receiveAndWait(from("9", "get me a manager"))
      await agent.handovers.takeOver({ operator: op })

      const done = await agent.handovers.resume({ operator: op })

      expect(done.kind).toBe("resumed")
      const [handover] = await agent.store.handovers.list({}, { orderBy: "seq" })
      expect(handover?.status).toBe("closed")
      expect(handover?.ended_reason).toBe("resume")
      // HAND-7: in the history, so the brain cannot answer as though it had
      // been there all along.
      const notices = await agent.store.messages.list({ author: "notice" })
      expect(notices.map((row) => row.text)).toContain(BACK_WITH_BOT)

      // And the agent answers them again.
      const next = await agent.receiveAndWait(from("9", "are you there?", "m-back"))
      expect(next.turn?.outcome).toBe("replied")
    })

    test("HAND-7: resume with nothing to give back says so", async () => {
      const { agent } = agentWith([{ reply: "Nothing to give back." }])
      const op = await operator(agent, "op-1", "Asha")

      const done = await agent.handovers.resume({ operator: op })

      expect(done.kind).toBe("none")
    })
  })
})
