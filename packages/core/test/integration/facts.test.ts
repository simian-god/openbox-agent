// Section 10 and LOOP-7's full runtime block, on real turns.
//
// The claim worth proving is the one LOOP-7 makes about history: the brain
// is sent the last 30 messages and no further, so anything that has to
// outlive 30 messages has to be a fact. The test for that walks a person
// past the window and checks the agent still knows them.
import { test, expect, describe, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { type Agent, type AgentOptions } from "../../src/runtime/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool } from "../../src/tools/index.ts"
import { MAX_FACTS, MAX_FACT_VALUE } from "../../src/tools/facts.ts"
import { scriptedBrain, type ScriptedBrain } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import { fakeToolContext } from "../../src/testing/tool-context.ts"

const PROMPT = "You are the host at a restaurant."
const agents = trackAgents("facts.test.ts")

function createAgent(options: AgentOptions): Agent {
  return agents.create({ secret: "test-secret", ...options })
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
  } as never)
}

/** What a tool saw in `ctx.facts`, so TOOL-4 can be checked. */
let seen: Record<string, string> | undefined

const readFacts = defineTool({
  name: "read_facts",
  description: "Reports what the context knows about the person.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["a test asks"], dontCallWhen: ["never"] },
  examples: { should: ["peek"], shouldNot: ["hello"] },
  handler: async (_args, ctx) => {
    seen = { ...ctx.facts }
    return { facts: seen }
  },
})

describeDatabase("facts", (sql) => {
  let sender: FakeSender
  const clock = fixedClock("2026-10-19T06:00:00Z")

  beforeEach(async () => {
    await resetDatabase(sql())
    seen = undefined
    clock.set("2026-10-19T06:00:00Z")
  })

  function agentWith(
    script: Parameters<typeof scriptedBrain>[0],
    over: Record<string, unknown> = {},
  ): { agent: Agent; brain: ScriptedBrain } {
    const brain = scriptedBrain(script)
    sender = fakeSender()
    const agent = createAgent({
      config: config(over),
      deps: {
        brains: [brain],
        decisionModel: scriptedDecisionModel([]),
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: PROMPT,
      tools: [readFacts],
    })
    return { agent, brain }
  }

  const says = (text: string, id: string) => ({
    channel: "whatsapp",
    channelUserId: "42",
    channelMessageId: id,
    text,
  })

  const resultOf = (brain: ScriptedBrain, call: number): Record<string, unknown> => {
    const message = brain.calls[call]?.messages.at(-1) as { result?: Record<string, unknown> }
    return message.result ?? {}
  }

  describe("remember", () => {
    test("a fact is stored against the person", async () => {
      const { agent, brain } = agentWith([
        { tool: "remember", input: { key: "allergies", value: "peanuts" } },
        { reply: "Noted." },
      ])
      await agent.receiveAndWait(says("i am allergic to peanuts", "m1"))

      const facts = await agent.store.facts.list({}, { orderBy: "key" })
      expect(facts).toHaveLength(1)
      expect(facts[0]).toMatchObject({ key: "allergies", value: "peanuts" })
      expect(resultOf(brain, 1)["ok"]).toBe(true)
    })

    test("remembering the same key twice updates it rather than adding a second", async () => {
      // The unique constraint is what makes this true, so a brain cannot
      // leave two answers for a later turn to choose between.
      const { agent, brain } = agentWith([
        { tool: "remember", input: { key: "usual order", value: "masala dosa" } },
        { tool: "remember", input: { key: "Usual-Order", value: "paneer thali" } },
        { reply: "Noted." },
      ])
      await agent.receiveAndWait(says("my usual is the thali now", "m1"))

      const facts = await agent.store.facts.list({}, { orderBy: "key" })
      expect(facts).toHaveLength(1)
      expect(facts[0]?.value).toBe("paneer thali")
      // And the brain is told it replaced something, not added to it.
      expect(resultOf(brain, 2)["replaced"]).toBe("masala dosa")
    })

    test("a key with nothing usable in it is refused, not stored as empty", async () => {
      const { agent, brain } = agentWith([
        { tool: "remember", input: { key: "???", value: "something" } },
        { reply: "I could not note that." },
      ])
      await agent.receiveAndWait(says("remember ???", "m1"))

      expect(await agent.store.facts.count()).toBe(0)
      expect(resultOf(brain, 1)["ok"]).toBe(false)
    })

    test("a value too long is refused rather than cut in half", async () => {
      // A fact cut off halfway reads as a whole fact on every later turn,
      // and nothing downstream can tell something was lost.
      const { agent, brain } = agentWith([
        { tool: "remember", input: { key: "notes", value: "x".repeat(MAX_FACT_VALUE + 1) } },
        { reply: "Too long." },
      ])
      await agent.receiveAndWait(says("remember all of this", "m1"))

      expect(await agent.store.facts.count()).toBe(0)
      expect(String(resultOf(brain, 1)["error"])).toContain(String(MAX_FACT_VALUE))
    })

    test("there is a limit on how many facts one person can have", async () => {
      // A first turn that touches nothing, so the person exists with the
      // lease the worker needs, before the facts are filled in.
      const { agent, brain } = agentWith([
        { reply: "Hello." },
        { tool: "remember", input: { key: "one_more", value: "x" } },
        { reply: "Full." },
      ])
      await agent.receiveAndWait(says("hello", "m0"))
      const person = await agent.store.people.find({ channel_user_id: "42" })
      await agent.store.facts.insertMany(
        Array.from({ length: MAX_FACTS }, (_, index) => ({
          person_id: person?.id ?? "",
          key: `fact_${index}`,
          value: "x",
          updated_at: clock.now().toISOString(),
        })),
      )

      await agent.receiveAndWait(says("remember one more thing", "m1"))

      expect(await agent.store.facts.count()).toBe(MAX_FACTS)
      expect(String(resultOf(brain, 2)["error"])).toContain("forget_fact")
    })

    test("an existing key can still be updated when the person is at the limit", async () => {
      // Otherwise a correction becomes impossible exactly when the agent
      // knows the most about somebody.
      const { agent } = agentWith([
        { reply: "Hello." },
        { tool: "remember", input: { key: "fact_0", value: "corrected" } },
        { reply: "Noted." },
      ])
      await agent.receiveAndWait(says("hello", "m0"))
      const person = await agent.store.people.find({ channel_user_id: "42" })
      await agent.store.facts.insertMany(
        Array.from({ length: MAX_FACTS }, (_, index) => ({
          person_id: person?.id ?? "",
          key: `fact_${index}`,
          value: "x",
          updated_at: clock.now().toISOString(),
        })),
      )

      await agent.receiveAndWait(says("actually fact zero is different", "m1"))

      expect(await agent.store.facts.count()).toBe(MAX_FACTS)
      expect((await agent.store.facts.find({ key: "fact_0" }))?.value).toBe("corrected")
    })

    test("DATA-1: one person's facts are not another's", async () => {
      const { agent } = agentWith([
        { tool: "remember", input: { key: "allergies", value: "peanuts" } },
        { reply: "Noted." },
        { reply: "Hello." },
      ])
      await agent.receiveAndWait(says("i am allergic to peanuts", "m1"))
      await agent.receiveAndWait({
        channel: "whatsapp",
        channelUserId: "99",
        channelMessageId: "m2",
        text: "hello",
      })

      const other = await agent.store.people.find({ channel_user_id: "99" })
      expect(await agent.store.facts.count({ person_id: other?.id ?? "" })).toBe(0)
    })
  })

  describe("forget_fact", () => {
    test("it removes the fact", async () => {
      const { agent, brain } = agentWith([
        { tool: "remember", input: { key: "usual_order", value: "thali" } },
        { tool: "forget_fact", input: { key: "Usual Order" } },
        { reply: "Forgotten." },
      ])
      await agent.receiveAndWait(says("forget my usual", "m1"))

      expect(await agent.store.facts.count()).toBe(0)
      expect(resultOf(brain, 2)["ok"]).toBe(true)
    })

    test("forgetting what was never remembered says what is remembered", async () => {
      const { agent, brain } = agentWith([
        { tool: "remember", input: { key: "allergies", value: "peanuts" } },
        { tool: "forget_fact", input: { key: "birthday" } },
        { reply: "I never had that." },
      ])
      await agent.receiveAndWait(says("forget my birthday", "m1"))

      const result = resultOf(brain, 2)
      expect(result["ok"]).toBe(false)
      expect(String(result["error"])).toContain("allergies")
      // And it did not take the wrong one instead.
      expect(await agent.store.facts.count()).toBe(1)
    })

    test("with nothing remembered at all, it says so plainly", async () => {
      const { agent, brain } = agentWith([
        { tool: "forget_fact", input: { key: "anything" } },
        { reply: "Nothing to forget." },
      ])
      await agent.receiveAndWait(says("forget everything", "m1"))

      expect(String(resultOf(brain, 1)["error"])).toContain("nothing remembered")
    })
  })

  describe("DATA-1 and DATA-2: whose fact it is", () => {
    test("DATA-1: one person cannot forget another's fact", async () => {
      const { agent, brain } = agentWith([
        { tool: "remember", input: { key: "allergies", value: "peanuts" } },
        { reply: "Noted." },
        { tool: "forget_fact", input: { key: "allergies" } },
        { reply: "Nothing to forget." },
      ])
      await agent.receiveAndWait(says("i am allergic to peanuts", "m1"))

      // A second person, asking to forget the same key.
      await agent.receiveAndWait({
        channel: "whatsapp",
        channelUserId: "99",
        channelMessageId: "m2",
        text: "forget my allergies",
      })

      const first = await agent.store.people.find({ channel_user_id: "42" })
      expect(await agent.store.facts.count({ person_id: first?.id ?? "" })).toBe(1)
      expect(String(resultOf(brain, 2)["error"])).toContain("nothing remembered")
    })

    test("DATA-2: the database refuses two facts under one key", async () => {
      // The backstop behind `remember`'s read then write. Without it two
      // writers would leave two answers for a later turn to choose from.
      const { agent } = agentWith([{ reply: "Hello." }])
      await agent.receiveAndWait(says("hello", "m1"))
      const person = await agent.store.people.find({ channel_user_id: "42" })

      await agent.store.facts.insert({
        person_id: person?.id ?? "",
        key: "allergies",
        value: "peanuts",
        updated_at: clock.now().toISOString(),
      })

      let refused = false
      try {
        await agent.store.facts.insert({
          person_id: person?.id ?? "",
          key: "allergies",
          value: "shellfish",
          updated_at: clock.now().toISOString(),
        })
      } catch {
        refused = true
      }

      expect(refused).toBe(true)
      expect(await agent.store.facts.count()).toBe(1)
    })

    test("section 10: remember survives losing that race", async () => {
      // Two writers, the same key, neither having seen the other. One
      // insert wins and the other becomes the update it would have been a
      // moment later, rather than a tool error the brain has to read.
      const { agent } = agentWith([{ reply: "Hello." }])
      await agent.receiveAndWait(says("hello", "m1"))
      const person = await agent.store.people.find({ channel_user_id: "42" })
      const remember = agent.tools.get("remember")
      expect(remember).toBeDefined()

      const ctx = fakeToolContext({
        config: config(),
        db: agent.store,
        clock,
        person: { id: person?.id ?? "" },
      })

      const [first, second] = (await Promise.all([
        remember?.handler({ key: "allergies", value: "peanuts" } as never, ctx),
        remember?.handler({ key: "allergies", value: "peanuts" } as never, ctx),
      ])) as { ok?: boolean }[]

      expect(first?.ok).toBe(true)
      expect(second?.ok).toBe(true)
      expect(await agent.store.facts.count()).toBe(1)
    })
  })

  describe("LOOP-7: the full runtime block", () => {
    test("LOOP-7: the brain is shown what is known about the person", async () => {
      const { agent, brain } = agentWith([
        { tool: "remember", input: { key: "allergies", value: "peanuts" } },
        { reply: "Noted." },
        { reply: "Hello again." },
      ])
      await agent.receiveAndWait(says("i am allergic to peanuts", "m1"))
      await agent.receiveAndWait(says("hello again", "m2"))

      const system = brain.calls[2]?.system ?? ""
      expect(system).toContain("# What you know about them")
      expect(system).toContain("- allergies: peanuts")
      // And told what to do when one of them changes, which is the half a
      // brain gets wrong: it corrects the person instead of the record.
      expect(system).toContain("call remember")
      expect(system).toContain("when something here changes")
    })

    test("LOOP-7: with nothing known, the block does not mention it", async () => {
      const { agent, brain } = agentWith([{ reply: "Hello." }])
      await agent.receiveAndWait(says("hello", "m1"))

      expect(brain.calls[0]?.system ?? "").not.toContain("# What you know about them")
    })

    test("LOOP-7: everything the Spec lists is in the block at once", async () => {
      // The full runtime block, which is what this row is for: date, time,
      // weekday, timezone, role, channel, facts, open tasks, pending
      // actions and today's and tomorrow's hours.
      const { agent, brain } = agentWith(
        [
          { tool: "remember", input: { key: "allergies", value: "peanuts" } },
          { tool: "start_task", input: { type: "booking", fields: { size: 4 } } },
          { reply: "Noted." },
          { reply: "Hello again." },
        ],
        { taskTypes: { booking: { fields: { date: "required", size: "required" } } } },
      )
      await agent.receiveAndWait(says("allergic to peanuts, table for four", "m1"))
      await agent.receiveAndWait(says("hello again", "m2"))

      const system = brain.calls[3]?.system ?? ""
      for (const part of [
        "# Right now",
        "Date: 2026-10-19 (Monday)",
        "Time: 11:30 (Asia/Kolkata)",
        "Tomorrow: 2026-10-20 (Tuesday)",
        "# Who you are talking to",
        "Role: end_user",
        "Channel: whatsapp",
        "# What you know about them",
        "- allergies: peanuts",
        "# Opening hours",
        "# Open tasks",
        "booking (active)",
        "still missing: date",
      ]) {
        expect(system).toContain(part)
      }
    })

    test("LOOP-7: a fact outlives the history window, which is why it exists", async () => {
      // The brain is sent the last `history` messages and no further. This
      // walks the person past that window and checks the agent still knows
      // them, which is the whole reason a fact is a row.
      const { agent, brain } = agentWith(
        [{ tool: "remember", input: { key: "allergies", value: "peanuts" } }, { reply: "Noted." }],
        { history: 4 },
      )
      await agent.receiveAndWait(says("i am allergic to peanuts", "m1"))

      for (let index = 0; index < 6; index++) {
        brain.push({ reply: `ok ${index}` })
        await agent.receiveAndWait(says(`chat ${index}`, `c${index}`))
      }

      const last = brain.calls.at(-1)
      // The first message is long gone from the history.
      const texts = (last?.messages ?? []).map((message) => (message as { text?: string }).text)
      expect(texts).not.toContain("i am allergic to peanuts")
      // And the agent still knows.
      expect(last?.system ?? "").toContain("- allergies: peanuts")
    })
  })

  describe("TOOL-4: ctx.facts", () => {
    test("TOOL-4: a handler is given what is known about the person", async () => {
      const { agent } = agentWith([
        { tool: "remember", input: { key: "allergies", value: "peanuts" } },
        { reply: "Noted." },
        { tool: "read_facts", input: {} },
        { reply: "Read." },
      ])
      await agent.receiveAndWait(says("i am allergic to peanuts", "m1"))
      await agent.receiveAndWait(says("what do you know", "m2"))

      expect(seen).toEqual({ allergies: "peanuts" })
    })

    test("TOOL-4: the facts a step sees are the ones the turn started with", async () => {
      // One turn, one view of the person. A tool that saw a fact appear
      // mid turn would behave differently depending on step order.
      const { agent } = agentWith([
        { tool: "remember", input: { key: "allergies", value: "peanuts" } },
        { tool: "read_facts", input: {} },
        { reply: "Done." },
      ])
      await agent.receiveAndWait(says("allergic to peanuts, and what do you know?", "m1"))

      expect(seen).toEqual({})
      // Stored all the same, and the next turn sees it.
      expect(await agent.store.facts.count()).toBe(1)
    })

    test("TOOL-4: ctx.facts cannot be written through", async () => {
      const writes = defineTool({
        name: "try_to_write",
        description: "Tries to change ctx.facts directly.",
        input: z.object({}),
        risk: "read",
        roles: ["end_user"],
        conditions: { callWhen: ["a test asks"], dontCallWhen: ["never"] },
        examples: { should: ["write"], shouldNot: ["hello"] },
        handler: async (_args, ctx) => {
          let refused = false
          try {
            ;(ctx.facts as Record<string, string>)["allergies"] = "nothing at all"
          } catch {
            refused = true
          }
          return { refused, value: ctx.facts["allergies"] }
        },
      })

      const brain = scriptedBrain([
        { tool: "remember", input: { key: "allergies", value: "peanuts" } },
        { reply: "Noted." },
        { tool: "try_to_write", input: {} },
        { reply: "Done." },
      ])
      sender = fakeSender()
      const agent = createAgent({
        config: config(),
        deps: {
          brains: [brain],
          decisionModel: scriptedDecisionModel([]),
          db: localSupabase(),
          sender,
          clock,
        },
        prompt: PROMPT,
        tools: [writes],
      })

      await agent.receiveAndWait(says("i am allergic to peanuts", "m1"))
      await agent.receiveAndWait(says("try it", "m2"))

      // Frozen, so the only way to change a fact is `remember`, which is
      // the only path that normalises a key.
      const result = brain.calls[3]?.messages.at(-1) as { result?: { value?: string } }
      expect(result.result?.value).toBe("peanuts")
      expect(await agent.store.facts.count()).toBe(1)
    })
  })
})
