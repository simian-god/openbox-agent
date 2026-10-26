// HAND-8 and LEARN-6: what the agent learns from a handover.
//
// A handover is the agent failing to answer something and a person
// answering it instead, so that exchange is the most valuable thing in
// the system. These tests are written around the two ways it is wasted:
// the pair is never saved, or it is saved and treated as true, which
// would let one colleague's reply to one customer become the agent's
// answer to everyone.
import { test, expect, describe, beforeAll, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { migrate } from "../../src/migrate/index.ts"
import { type Agent, type AgentOptions } from "../../src/runtime/index.ts"
import { createHandovers, WANTS_HUMAN } from "../../src/runtime/handover.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool } from "../../src/tools/index.ts"
import { scriptedBrain, type ScriptedStep } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import type { Brain, BrainInput, BrainOutput } from "../../src/providers/brains/types.ts"
import type { HandoverRow, PersonRow, Store } from "../../src/store/index.ts"

const SECRET = "test-secret-long-enough-to-look-real"
const PROMPT = "You are the host at a restaurant."
const SUMMARY = "They want a table.\nThe agent could not help.\nThey are waiting."

const agents = trackAgents("knowledge.test.ts")

function config(): OpenboxConfig {
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
  })
}

const table = defineTool({
  name: "check_availability",
  description: "Checks whether a table is free.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask about a table"], dontCallWhen: ["they do not"] },
  examples: { should: ["any space?"], shouldNot: ["hello"] },
  handler: async () => ({ free: true }),
})

function testBrain(script: ScriptedStep[]): { brain: Brain; calls: BrainInput[] } {
  const scripted = scriptedBrain(script, { exhaustedReply: "Anything else?" })

  const brain: Brain = {
    id: "scripted",
    kind: "api",
    supportsImages: true,
    async complete(input: BrainInput): Promise<BrainOutput> {
      if (input.system.includes("three short lines")) {
        return {
          text: SUMMARY,
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.0001 },
        }
      }
      return scripted.complete(input)
    },
  }

  return { brain, calls: scripted.calls }
}

describeDatabase("knowledge from handovers", (sql) => {
  const clock = fixedClock("2026-10-19T07:00:00Z")
  let sender: FakeSender

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
    clock.set("2026-10-19T07:00:00Z")
  })

  function build(script: ScriptedStep[]): { agent: Agent; calls: BrainInput[] } {
    const { brain, calls } = testBrain(script)
    sender = fakeSender()
    const made: AgentOptions = {
      secret: SECRET,
      config: config(),
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
      tools: [table],
    }
    return { agent: agents.create(made), calls }
  }

  const from = (who: string, text: string, id = `m-${who}-${text.slice(0, 10)}`) => ({
    channel: "whatsapp",
    channelUserId: who,
    channelMessageId: id,
    text,
  })

  const script: ScriptedStep[] = [
    { tool: "escalate", input: { why: "they asked" } },
    { reply: "Someone will be with you." },
  ]

  /** An active handover, held by Asha, with Riya waiting. */
  async function active(): Promise<{
    agent: Agent
    asha: PersonRow
    riya: PersonRow
    handover: HandoverRow
  }> {
    const { agent } = build(script)
    const asha = await agent.store.people.insert({
      channel: "whatsapp",
      channel_user_id: "op-1",
      role: "operator",
      display_name: "Asha",
    })
    await agent.store.people.insert({
      channel: "whatsapp",
      channel_user_id: "9",
      display_name: "Riya",
    })
    await agent.receiveAndWait(from("9", "get me a manager"))
    await agent.handovers.takeOver({ operator: asha })
    await agent.outbox.pump.drain()
    sender.reset()

    const riya = (await agent.store.people.find({ channel_user_id: "9" })) as PersonRow
    const handover = (await agent.store.handovers.find({ person_id: riya.id })) as HandoverRow
    return { agent, asha, riya, handover }
  }

  describe("HAND-8: the question and the answer", () => {
    test("HAND-8: a colleague's answer is saved with the question it answered", async () => {
      const { agent, asha, riya, handover } = await active()

      await agent.receiveAndWait(from("9", "do you have high chairs?", "m-ask"))
      await agent.receiveAndWait(from("op-1", "yes, we have three"))

      const [candidate] = await agent.store.knowledge.list({}, { orderBy: "seq" })
      expect(candidate?.question).toBe("do you have high chairs?")
      expect(candidate?.answer).toBe("yes, we have three")
      // LEARN-6: a candidate, and nothing more, until an operator says so.
      expect(candidate?.status).toBe("candidate")
      expect(candidate?.decided_at).toBeNull()
      expect(candidate?.source).toBe("handover")
      // Who answered it, which is who to ask if the answer looks wrong.
      expect(candidate?.operator_id).toBe(asha.id)
      expect(candidate?.person_id).toBe(riya.id)
      expect(candidate?.handover_id).toBe(handover.id)
    })

    test("HAND-8: the message that caused the handover is not the question", async () => {
      // "get me a manager" is not a question anyone wants in a knowledge
      // base, and it was said before the handover existed.
      const { agent } = await active()

      await agent.receiveAndWait(from("op-1", "hello, Asha here, how can I help?"))

      expect(await agent.store.knowledge.count()).toBe(0)
    })

    test("HAND-8: something said before the handover existed is not the question", async () => {
      // An operator opening one themselves, on a conversation that went
      // quiet days ago. Their first words are not an answer to whatever
      // the person last happened to say.
      const { agent } = build([{ reply: "We open at 11." }])
      const asha = await agent.store.people.insert({
        channel: "whatsapp",
        channel_user_id: "op-1",
        role: "operator",
        display_name: "Asha",
      })
      await agent.receiveAndWait(from("9", "are you open on Sunday?"))
      const riya = (await agent.store.people.find({ channel_user_id: "9" })) as PersonRow

      // Two days later, an operator picks the conversation up.
      clock.advance(2 * 24 * 60 * 60 * 1000)
      const { handover } = await agent.handovers.open({ person: riya, reason: "operator" })
      await agent.handovers.takeOver({ operator: asha })

      await agent.handovers.relay({
        handover: (await agent.store.handovers.byId(handover.id)) as HandoverRow,
        items: [{ id: "inbox-row-1", text: "following up on your booking" }],
      })

      expect(await agent.store.knowledge.count()).toBe(0)
    })

    test("HAND-8: each question gets its own candidate", async () => {
      const { agent } = await active()

      await agent.receiveAndWait(from("9", "do you have high chairs?", "m-1"))
      await agent.receiveAndWait(from("op-1", "yes, three of them", "m-2"))
      await agent.receiveAndWait(from("9", "and parking?", "m-3"))
      await agent.receiveAndWait(from("op-1", "there is a lot behind the building", "m-4"))

      const rows = await agent.store.knowledge.list({}, { orderBy: "seq" })
      expect(rows.map((row) => [row.question, row.answer])).toEqual([
        ["do you have high chairs?", "yes, three of them"],
        ["and parking?", "there is a lot behind the building"],
      ])
    })

    test("HAND-8: a colleague saying more does not become a second thing to review", async () => {
      const { agent } = await active()

      await agent.receiveAndWait(from("9", "do you have high chairs?", "m-1"))
      await agent.receiveAndWait(from("op-1", "yes, three of them", "m-2"))
      await agent.receiveAndWait(from("op-1", "they are by the window", "m-3"))

      // One question, one candidate. The operator's extra line is them
      // being helpful, not a second question to approve.
      expect(await agent.store.knowledge.count()).toBe(1)
      const [row] = await agent.store.knowledge.list({})
      expect(row?.answer).toBe("yes, three of them")
    })

    test("HAND-8: relaying the same words twice captures one candidate", async () => {
      const { agent, handover } = await active()
      await agent.receiveAndWait(from("9", "do you have high chairs?", "m-1"))

      const items = [{ id: "inbox-row-1", text: "yes, three of them" }]
      await agent.handovers.relay({ handover, items })
      await agent.handovers.relay({ handover, items })

      expect(await agent.store.knowledge.count()).toBe(1)
    })

    test("HAND-8: an empty answer is not an answer", async () => {
      // A voice note from the operator, until MEDIA-1 transcribes it.
      const { agent, handover } = await active()
      await agent.receiveAndWait(from("9", "do you have high chairs?", "m-1"))

      await agent.handovers.relay({ handover, items: [{ id: "inbox-row-1", text: "   " }] })

      expect(await agent.store.knowledge.count()).toBe(0)
    })

    test("HAND-8: nothing is captured outside a handover", async () => {
      // An operator talking to the agent is not answering a customer.
      const { agent } = build([{ reply: "Nothing is waiting." }])
      await agent.store.people.insert({
        channel: "whatsapp",
        channel_user_id: "op-1",
        role: "operator",
        display_name: "Asha",
      })

      await agent.receiveAndWait(from("op-1", "we have three high chairs"))

      expect(await agent.store.knowledge.count()).toBe(0)
    })
  })

  describe("HAND-8: it can never cost the person their answer", () => {
    test("HAND-8: a relay goes out even when the candidate cannot be saved", async () => {
      // The words are what the person is waiting for. Losing a candidate
      // costs the agent a lesson; losing the relay costs them the answer.
      const { agent, handover } = await active()
      await agent.receiveAndWait(from("9", "do you have high chairs?", "m-1"))
      sender.reset()

      const broken: Store = {
        ...agent.store,
        knowledge: {
          ...agent.store.knowledge,
          insert: async () => {
            throw new Error("the knowledge table is gone")
          },
        },
      }
      const handovers = createHandovers({
        config: config(),
        store: broken,
        clock,
        events: agent.events,
        outbox: agent.outbox,
      })

      const sent = await handovers.relay({
        handover,
        items: [{ id: "inbox-row-1", text: "yes, three of them" }],
      })

      expect(sent).toBe(1)
      await agent.outbox.pump.drain()
      expect(sender.texts()).toEqual(["yes, three of them"])
    })
  })

  describe("PRIV-3: a candidate is still the person's words", () => {
    test("PRIV-3: erasing the person takes their candidate with them", async () => {
      // PRIV-3 lists the tables erasure clears and knowledge is not among
      // them, because knowledge did not exist when it was written. The
      // cascade is here so erasure cannot leave a person's question
      // behind in a table nobody thought to clear.
      const { agent, riya } = await active()
      await agent.receiveAndWait(from("9", "do you have high chairs?", "m-1"))
      await agent.receiveAndWait(from("op-1", "yes, three of them", "m-2"))
      expect(await agent.store.knowledge.count()).toBe(1)

      await agent.store.people.remove({ id: riya.id })

      expect(await agent.store.knowledge.count()).toBe(0)
    })
  })
})
