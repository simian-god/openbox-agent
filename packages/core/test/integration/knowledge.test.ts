// HAND-8 and LEARN-6: what the agent learns from a handover.
//
// A handover is the agent failing to answer something and a person
// answering it instead, so that exchange is the most valuable thing in
// the system. These tests are written around the two ways it is wasted:
// the pair is never saved, or it is saved and treated as true, which
// would let one colleague's reply to one customer become the agent's
// answer to everyone.
import { test, expect, describe, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
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
import type { KnowledgeDoc } from "../../src/knowledge/index.ts"
import type { Retriever } from "../../src/providers/retrievers/types.ts"

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

  beforeEach(async () => {
    await resetDatabase(sql())
    clock.set("2026-10-19T07:00:00Z")
  })

  function build(
    script: ScriptedStep[],
    how: {
      knowledge?: KnowledgeDoc[]
      retriever?: Retriever
      onWorkerError?: (error: unknown) => void
    } = {},
  ): { agent: Agent; calls: BrainInput[] } {
    const { brain, calls } = testBrain(script)
    sender = fakeSender()
    const made: AgentOptions = {
      secret: SECRET,
      config: config(),
      ...(how.knowledge !== undefined ? { knowledge: how.knowledge } : {}),
      deps: {
        brains: [brain],
        decisionModel: scriptedDecisionModel([
          { [WANTS_HUMAN]: yesno(0), [GATE_QUESTION]: yesno(1) },
        ]),
        db: localSupabase(),
        sender,
        clock,
        ...(how.retriever !== undefined ? { retriever: how.retriever } : {}),
      },
      ...(how.onWorkerError !== undefined ? { onWorkerError: how.onWorkerError } : {}),
      prompt: PROMPT,
      tools: [table],
    }
    return { agent: agents.create(made), calls }
  }

  /** Waits for something to become true, or gives up so a test can fail. */
  async function until(what: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms
    while (!what() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
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

  describe("KNOW-1 and KNOW-3: searching the agent's own documents", () => {
    const DOCS: KnowledgeDoc[] = [
      {
        id: "p",
        text: "Parking\n\nThere is a free lot behind the building.",
        source: "faq.md#Parking",
      },
      {
        id: "r",
        text: "Refunds\n\nWithin seven days, with the receipt.",
        source: "faq.md#Refunds",
      },
    ]

    const asking: ScriptedStep[] = [
      { tool: "search_knowledge", input: { query: "where do I park" } },
      { reply: "There is a free lot behind the building." },
    ]

    test("KNOW-1 and KNOW-3: a document passed in is searchable, and says where it came from", async () => {
      const { agent, calls } = build(asking, { knowledge: DOCS })

      await agent.receiveAndWait(from("9", "where do I park?"))

      // The brain called the tool and got the chunk back with its source.
      const result = calls[1]?.messages.at(-1)
      const said = JSON.stringify(result)
      expect(said).toContain("free lot behind the building")
      expect(said).toContain("faq.md#Parking")
    })

    test("KNOW-3: the score is not handed to the brain", async () => {
      // It is normalised against the best match for that one query
      // (KNOW-4), so it means nothing on its own, and a brain given a
      // number will reason about it.
      const { agent, calls } = build(asking, { knowledge: DOCS })

      await agent.receiveAndWait(from("9", "where do I park?"))

      expect(JSON.stringify(calls[1]?.messages.at(-1))).not.toContain("score")
    })

    test("KNOW-3: no more than knowledgeResults come back", async () => {
      const many: KnowledgeDoc[] = Array.from({ length: 9 }, (_unused, at) => ({
        id: `d${at}`,
        text: `Parking ${at}\n\nParking information number ${at}.`,
        source: `faq.md#Parking${at}`,
      }))
      const { agent, calls } = build(asking, { knowledge: many })

      await agent.receiveAndWait(from("9", "where do I park?"))

      const result = calls[1]?.messages.at(-1)
      const payload = (result !== undefined && "result" in result ? result.result : {}) as {
        results?: unknown[]
      }
      expect(payload.results).toHaveLength(5)
    })

    test("KNOW-3: nothing found tells the brain to say so rather than inventing", async () => {
      const { agent, calls } = build(
        [
          { tool: "search_knowledge", input: { query: "helicopter maintenance" } },
          { reply: "I do not have that, sorry." },
        ],
        { knowledge: DOCS },
      )

      await agent.receiveAndWait(from("9", "do you service helicopters?"))

      const said = JSON.stringify(calls[1]?.messages.at(-1))
      expect(said).toContain("Nothing in the documents matches")
    })

    test("EVT-2: a search is recorded, with how much it found", async () => {
      const { agent } = build(asking, { knowledge: DOCS })

      await agent.receiveAndWait(from("9", "where do I park?"))

      const events = await agent.store.events.list(
        { name: "knowledge_searched" },
        { orderBy: "seq" },
      )
      expect(events).toHaveLength(1)
      expect((events[0]?.props as { results?: number }).results).toBe(1)
      expect((events[0]?.props as { retriever?: string }).retriever).toBe("local")
    })

    // C18 is about the person getting the answer, not about the brain
    // getting the chunk. Every other test here stops at the brain, so
    // without this one the whole criterion could pass while the reply was
    // built and never sent.
    test("C18: the answer out of the file reaches the person, on local", async () => {
      const { agent } = build(asking, { knowledge: DOCS })

      await agent.receiveAndWait(from("9", "where do I park?"))

      expect(sender.texts()).toEqual(["There is a free lot behind the building."])
    })

    test("KNOW-1: an agent with no documents searches nothing, rather than failing", async () => {
      const { agent, calls } = build([
        { tool: "search_knowledge", input: { query: "parking" } },
        { reply: "I do not have that." },
      ])

      await agent.receiveAndWait(from("9", "parking?"))

      expect(JSON.stringify(calls[1]?.messages.at(-1))).toContain("Nothing in the documents")
    })
  })

  describe("KNOW-2 and LEARN-6: deciding on a candidate", () => {
    /** A candidate waiting for a decision, as a handover would leave it. */
    async function candidate(agent: Agent): Promise<string> {
      const row = await agent.store.knowledge.insert({
        question: "do you have parking?",
        answer: "Yes, there is a free lot behind the building.",
        status: "candidate",
        source: "handover",
        handover_id: null,
        person_id: null,
        operator_id: null,
        question_message_id: null,
        decided_at: null,
        decided_by: null,
      })
      return row.id
    }

    /** An operator on this agent, so the two decisions are offered. */
    async function operatorOn(agent: Agent, id: string): Promise<void> {
      await agent.store.people.insert({
        channel: "whatsapp",
        channel_user_id: id,
        role: "operator",
        display_name: "Asha",
      })
    }

    const searching = (query: string): ScriptedStep[] => [
      { tool: "search_knowledge", input: { query } },
      { reply: "Checked." },
    ]

    test("LEARN-6: a candidate is not searchable, however good the answer is", async () => {
      // The whole of LEARN-6. One colleague's reply to one customer must
      // not become the agent's answer to everyone before somebody checks.
      const { agent, calls } = build(searching("parking"))
      await candidate(agent)

      await agent.receiveAndWait(from("9", "parking?"))

      expect(JSON.stringify(calls[1]?.messages.at(-1))).toContain("Nothing in the documents")
    })

    test("KNOW-1 and LEARN-6: an approved entry is indexed at start", async () => {
      const { agent } = build(searching("parking"))
      const id = await candidate(agent)
      await agent.store.knowledge.update({ id }, { status: "approved" })

      // A second agent on the same database, so this one indexes at start
      // with the entry already approved.
      const second = build(searching("parking"))
      await second.agent.receiveAndWait(from("8", "parking?"))

      const said = JSON.stringify(second.calls[1]?.messages.at(-1))
      expect(said).toContain("free lot behind the building")
      expect(said).toContain(`entry:${id}`)
    })

    test("KNOW-2: approving makes it searchable at once, with no restart", async () => {
      // The one thing in this core that changes what the agent knows
      // while it is running (LEARN-7). The operator answered a minute
      // ago; the next person to ask should get the answer.
      //
      // One agent, two turns, and that is the whole point. The first
      // version of this test approved on one agent and asked on another,
      // which re-reads the table at start, so it passed with the live
      // indexing removed entirely. A probe found that.
      const { agent, calls } = build([
        { tool: "approve_knowledge", input: { entry_id: "filled in below" } },
        { reply: "Approved." },
        { tool: "search_knowledge", input: { query: "parking" } },
        { reply: "There is a free lot." },
      ])
      const id = await candidate(agent)
      await operatorOn(agent, "op-2")

      // The script was built before the id existed, so the call the brain
      // makes is scripted against the real one here.
      const scripted = build([
        { tool: "approve_knowledge", input: { entry_id: id } },
        { reply: "Approved." },
        { tool: "search_knowledge", input: { query: "parking" } },
        { reply: "There is a free lot." },
      ])
      await operatorOn(scripted.agent, "op-3")

      await scripted.agent.receiveAndWait(from("op-3", "approve that one"))
      expect((await scripted.agent.store.knowledge.byId(id))?.status).toBe("approved")

      // The same agent, no restart, an ordinary person asking.
      await scripted.agent.receiveAndWait(from("7", "parking?"))

      const said = JSON.stringify(scripted.calls.at(-1)?.messages.at(-1))
      expect(said).toContain("free lot")
      expect(calls.length).toBeGreaterThanOrEqual(0)
    })

    test("LEARN-6: the answer is searchable too, not only the question", async () => {
      // "lot" appears in the answer and nowhere in the question. A person
      // usually phrases it like the question, and needs the answer back,
      // so both have to be in the text that is indexed.
      const { agent } = build(searching("parking"))
      const id = await candidate(agent)
      await agent.store.knowledge.update({ id }, { status: "approved" })

      const asking = build(searching("lot behind the building"))
      await asking.agent.receiveAndWait(from("5", "is there a lot?"))

      expect(JSON.stringify(asking.calls[1]?.messages.at(-1))).toContain("free lot")
    })

    test("LEARN-6: rejecting keeps the record and never makes it searchable", async () => {
      const { agent } = build(searching("parking"))
      const id = await candidate(agent)

      // One agent again, for the same reason as the test above: a second
      // agent re-reads the table and would pass even if rejecting had
      // indexed the answer.
      const deciding = build([
        { tool: "reject_knowledge", input: { entry_id: id } },
        { reply: "Rejected." },
        { tool: "search_knowledge", input: { query: "parking" } },
        { reply: "I do not have that." },
      ])
      await operatorOn(deciding.agent, "op-6")
      await deciding.agent.receiveAndWait(from("op-6", "no, that is wrong"))

      const after = await deciding.agent.store.knowledge.byId(id)
      expect(after?.status).toBe("rejected")
      // The pair is still there to read, which is the point of a record.
      expect(after?.answer).toContain("free lot")

      await deciding.agent.receiveAndWait(from("6", "parking?"))
      expect(JSON.stringify(deciding.calls.at(-1)?.messages.at(-1))).toContain(
        "Nothing in the documents",
      )
    })

    test("DATA-4: deciding twice is told the outcome, not told it failed", async () => {
      // Two operators at once, or one message delivered twice. The claim
      // is on `status: "candidate"`, so exactly one decision lands and
      // the second is answered rather than refused.
      const { agent } = build(searching("parking"))
      const id = await candidate(agent)

      const deciding = build([
        { tool: "approve_knowledge", input: { entry_id: id } },
        { tool: "approve_knowledge", input: { entry_id: id } },
        { reply: "Done." },
      ])
      await operatorOn(deciding.agent, "op-4")
      await deciding.agent.receiveAndWait(from("op-4", "approve it"))

      const runs = await deciding.agent.store.toolRuns.list(
        { tool: "approve_knowledge" },
        { orderBy: "seq" },
      )
      expect(runs).toHaveLength(2)
      expect(runs.every((run) => run.status === "ok")).toBe(true)
      const second = runs[1]?.result as { ok?: boolean; why?: string }
      expect(second.ok).toBe(true)
      expect(String(second.why)).toContain("already been decided")
    })

    test("a candidate that does not exist is said so, rather than throwing", async () => {
      const { agent } = build([
        { tool: "approve_knowledge", input: { entry_id: "00000000-0000-0000-0000-000000000000" } },
        { reply: "I could not find that." },
      ])
      await operatorOn(agent, "op-5")

      await agent.receiveAndWait(from("op-5", "approve 0000"))

      const runs = await agent.store.toolRuns.list(
        { tool: "approve_knowledge" },
        { orderBy: "seq" },
      )
      expect(runs[0]?.status).toBe("ok")
      expect(String((runs[0]?.result as { why?: string }).why)).toContain("no knowledge candidate")
    })

    test("ROLE-3: an end user is never offered the two decisions", async () => {
      const { agent, calls } = build(searching("parking"))

      await agent.receiveAndWait(from("9", "parking?"))

      const offered = (calls[0]?.tools ?? []).map((tool) => tool.name)
      expect(offered).toContain("search_knowledge")
      expect(offered).not.toContain("approve_knowledge")
      expect(offered).not.toContain("reject_knowledge")
    })
  })

  describe("KNOW-1: when the index is built, and how often", () => {
    /** A retriever that records what it was asked and when. */
    function recording(options: { slowMs?: number; throws?: boolean } = {}) {
      const indexed: string[][] = []
      let ready = false
      const retriever: Retriever = {
        id: "recording",
        async index(docs) {
          if (options.slowMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, options.slowMs))
          }
          if (options.throws === true) throw new Error("the documents could not be read")
          indexed.push(docs.map((doc) => doc.source))
          ready = true
        },
        async search() {
          searchedWhileReady.push(ready)
          return []
        },
      }
      const searchedWhileReady: boolean[] = []
      return { retriever, indexed, searchedWhileReady }
    }

    const DOC: KnowledgeDoc = {
      id: "p",
      text: "Parking\n\nA free lot behind the building.",
      source: "faq.md#Parking",
    }

    test("KNOW-1: at start means at start, before anybody has asked anything", async () => {
      const { retriever, indexed } = recording()
      build([{ reply: "hello" }], { knowledge: [DOC], retriever })

      // No message sent. `start()` began it, which is what KNOW-1 says.
      await until(() => indexed.length > 0)

      expect(indexed[0]).toEqual(["faq.md#Parking"])
    })

    test("KNOW-1: the documents are indexed once, not on every search", async () => {
      const { retriever, indexed } = recording()
      const { agent } = build(
        [
          { tool: "search_knowledge", input: { query: "parking" } },
          { reply: "one" },
          { tool: "search_knowledge", input: { query: "parking" } },
          { reply: "two" },
        ],
        { knowledge: [DOC], retriever },
      )

      await agent.receiveAndWait(from("9", "parking?"))
      await agent.receiveAndWait(from("9", "parking again?"))

      expect(indexed).toHaveLength(1)
    })

    test("KNOW-1: a search waits for the index rather than searching half of it", async () => {
      // The index is deliberately slow here. A search that did not wait
      // would run against nothing and the person would be told there is
      // no answer when there is one.
      // Slower than the whole turn on purpose. At 120ms the index
      // finished before the turn ever reached the search, so removing the
      // wait changed nothing and a probe slipped past.
      const { retriever, searchedWhileReady } = recording({ slowMs: 1_500 })
      const { agent } = build(
        [{ tool: "search_knowledge", input: { query: "parking" } }, { reply: "checked" }],
        { knowledge: [DOC], retriever },
      )

      await agent.receiveAndWait(from("9", "parking?"))

      expect(searchedWhileReady).toEqual([true])
    })

    test("KNOW-1: documents that cannot be read are reported, and the agent still answers", async () => {
      // An agent whose knowledge folder is broken is still an agent. The
      // failure is loud in the trace and silent to the person.
      const { retriever } = recording({ throws: true })
      const reported: unknown[] = []
      const { agent } = build(
        [{ tool: "search_knowledge", input: { query: "parking" } }, { reply: "I cannot check." }],
        { knowledge: [DOC], retriever, onWorkerError: (error) => reported.push(error) },
      )

      await agent.receiveAndWait(from("9", "parking?"))

      expect(sender.texts()).toEqual(["I cannot check."])
      // More than once is right. A failed read is forgotten rather than
      // remembered, so the next search tries again instead of failing for
      // ever on one bad read, and `start()` and that search each report.
      expect(reported.length).toBeGreaterThanOrEqual(1)
      expect(
        reported.every((error) => String((error as Error).message).includes("could not be read")),
      ).toBe(true)
    })
  })
})
