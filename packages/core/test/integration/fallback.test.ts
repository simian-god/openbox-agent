// BRAIN-3, BRAIN-4 and BRAIN-5 on real turns.
//
// C2's second half is the claim here: "killing the primary brain mid
// conversation moves to the fallback with no lost message." So the tests
// are written as the outage rather than as the feature: a brain that
// throws, a brain that cannot produce the shape, a brain that is simply a
// bug, and every brain gone at once.
import { test, expect, describe, beforeAll, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { migrate } from "../../src/migrate/index.ts"
import { type Agent, type AgentOptions } from "../../src/runtime/index.ts"
import { BRAINS_FAILED_REPLY } from "../../src/runtime/limits.ts"
import { PERSON_TOLD } from "../../src/runtime/handover.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool } from "../../src/tools/index.ts"
import { scriptedBrain } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import { structuredBrain } from "../../src/providers/brains/structured.ts"
import { BrainError, type Brain } from "../../src/providers/brains/types.ts"

const PROMPT = "You are the host at a restaurant."
const agents = trackAgents("fallback.test.ts")

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

let ran: string[] = []

const look = defineTool({
  name: "check_availability",
  description: "Checks whether a table is free.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask about a table"], dontCallWhen: ["they do not"] },
  examples: { should: ["any space?"], shouldNot: ["hello"] },
  handler: async () => {
    ran.push("check_availability")
    return { free: true }
  },
})

const readMenu = defineTool({
  name: "read_menu",
  description: "Reads the menu.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask about food"], dontCallWhen: ["they do not"] },
  examples: { should: ["what's on?"], shouldNot: ["hello"] },
  handler: async () => {
    ran.push("read_menu")
    return { items: [] }
  },
})

/**
 * A brain that asks for several tools at once, then replies (BRAIN-3).
 *
 * The reply matters: a brain that asked for the same tools on every step
 * would run to the step cap, and the test would be measuring LOOP-9
 * instead of what it meant to.
 */
function brainAsking(names: string[]): Brain {
  let asked = false
  return {
    id: "greedy",
    kind: "api",
    supportsImages: false,
    complete: async () => {
      if (asked) {
        return { text: "Done.", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } }
      }
      asked = true
      return {
        toolCalls: names.map((name, index) => ({ id: `c${index}`, name, input: {} })),
        finishReason: "tool_calls",
        usage: { inputTokens: 10, outputTokens: 5 },
      }
    },
  }
}

describeDatabase("the fallback chain", (sql) => {
  let sender: FakeSender
  const clock = fixedClock("2026-10-19T06:00:00Z")

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
    ran = []
  })

  function agentWith(brains: Brain[], over: Record<string, unknown> = {}): Agent {
    sender = fakeSender()
    return createAgent({
      config: config(over),
      deps: {
        brains,
        decisionModel: scriptedDecisionModel([]),
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: PROMPT,
      tools: [look, readMenu],
    })
  }

  const hello = (over: Record<string, unknown> = {}) => ({
    channel: "whatsapp",
    channelUserId: "42",
    channelMessageId: "m1",
    text: "any space on monday?",
    ...over,
  })

  describe("BRAIN-5: moving to the next brain", () => {
    test("C2: a brain that is down is replaced, and the person is answered", async () => {
      const agent = agentWith([
        scriptedBrain([{ throws: "503 from the provider", retryable: true }], { id: "first" }),
        scriptedBrain([{ reply: "We open at 11." }], { id: "second" }),
      ])

      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.outcome).toBe("replied")
      expect(sender.texts()).toEqual(["We open at 11."])
      // LOOP-11: the turn records which brain answered, not which was asked.
      expect(result.turn?.brainsUsed).toEqual(["second"])
    })

    test("BRAIN-5: a brain that is a bug is replaced too, not just one that is down", async () => {
      // This used to end the turn, on the reasoning that a fallback would
      // mask a bug. The person lost their answer either way, and the bug
      // is in the trace regardless, so a slower answer beats none.
      const bug: Brain = {
        id: "buggy",
        kind: "api",
        supportsImages: false,
        complete: () => Promise.reject(new TypeError("undefined is not a function")),
      }
      const agent = agentWith([bug, scriptedBrain([{ reply: "We open at 11." }], { id: "second" })])

      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.outcome).toBe("replied")
      expect(result.turn?.brainsUsed).toEqual(["second"])
    })

    test("BRAIN-5: a brain that cannot produce the shape twice is replaced", async () => {
      // The shared adapter asks twice and gives up, which is what makes
      // BRAIN-5's "twice in a row" twice rather than once.
      let asked = 0
      const babbling = structuredBrain({
        id: "babbling",
        kind: "api",
        ask: async () => {
          asked++
          return { text: "I think we are open at eleven." }
        },
      })
      const agent = agentWith([
        babbling,
        scriptedBrain([{ reply: "We open at 11." }], { id: "second" }),
      ])

      const result = await agent.receiveAndWait(hello())

      expect(asked).toBe(2)
      expect(result.turn?.brainsUsed).toEqual(["second"])
      expect(sender.texts()).toEqual(["We open at 11."])
    })

    test("BRAIN-5: the chain is tried in order, and stops at the first that answers", async () => {
      const agent = agentWith([
        scriptedBrain([{ throws: "down" }], { id: "first" }),
        scriptedBrain([{ throws: "also down" }], { id: "second" }),
        scriptedBrain([{ reply: "Third time lucky." }], { id: "third" }),
        scriptedBrain([{ reply: "Never asked." }], { id: "fourth" }),
      ])

      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.brainsUsed).toEqual(["third"])
      expect(sender.texts()).toEqual(["Third time lucky."])
    })

    test("EVT-2: the fallback says which brain answered and why the others did not", async () => {
      const agent = agentWith([
        scriptedBrain([{ throws: "503 from the provider" }], { id: "first" }),
        scriptedBrain([{ reply: "ok" }], { id: "second" }),
      ])
      await agent.receiveAndWait(hello())

      const row = (await agent.store.events.list({ name: "fallback_used" }))[0]
      expect(row?.props).toMatchObject({ what: "brain", brain: "second" })
      // The reason, not just the name. Without it the event says a
      // fallback happened and nothing about why, which is the question.
      expect(JSON.stringify(row?.props["failed"])).toContain("503 from the provider")
    })

    test("LOOP-12: with every brain gone the person is told so, and the row stays findable", async () => {
      const agent = agentWith([
        scriptedBrain([{ throws: "down" }], { id: "first" }),
        scriptedBrain([{ throws: "also down" }], { id: "second" }),
      ])

      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.outcome).toBe("brains_failed")
      // LOOP-12: the fixed holding message, then HAND-2's line, because
      // the promise it just made needs an owner.
      expect(sender.texts()).toEqual([BRAINS_FAILED_REPLY, PERSON_TOLD])
      // Not `done` even so: a message nobody answered has to stay
      // findable, and nothing above answered it.
      const row = await agent.store.inbox.byId(result.inboxId)
      expect(row?.status).toBe("failed")
      expect(row?.turn_id).not.toBeNull()
    })

    test("LOOP-12: and the trace says every brain that was tried", async () => {
      const agent = agentWith([
        scriptedBrain([{ throws: "down" }], { id: "first" }),
        scriptedBrain([{ throws: "also down" }], { id: "second" }),
      ])
      await agent.receiveAndWait(hello())

      const row = (await agent.store.events.list({ name: "fallback_used" }))[0]
      expect(row?.props["brain"]).toBeNull()
      const failed = JSON.stringify(row?.props["failed"])
      expect(failed).toContain("first")
      expect(failed).toContain("second")
    })

    test("LOOP-12: a brain that deliberately says nothing leaves the row done", async () => {
      // The one outcome where nobody was answered and that is correct.
      // Marked `failed` it would keep being found by the recovery sweep
      // and the person would be answered twice for one message.
      const silent: Brain = {
        id: "silent",
        kind: "api",
        supportsImages: false,
        complete: async () => ({
          text: "",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 0 },
        }),
      }
      const agent = agentWith([silent])

      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.outcome).toBe("no_reply")
      expect(sender.texts()).toEqual([])
      const row = await agent.store.inbox.byId(result.inboxId)
      expect(row?.status).toBe("done")
    })

    test("BRAIN-5: a brain that answers first is never recorded as a fallback", async () => {
      const agent = agentWith([scriptedBrain([{ reply: "ok" }], { id: "first" })])
      await agent.receiveAndWait(hello())

      expect(await agent.store.events.count({ name: "fallback_used" })).toBe(0)
    })

    test("C2: the fallback is per step, so a later step starts from the primary again", async () => {
      // A provider that was down for a moment should not cost the rest of
      // the turn. Step one falls back; step two asks the primary first.
      const first = scriptedBrain([{ throws: "a blip" }, { reply: "Back again." }], {
        id: "first",
      })
      const second = scriptedBrain([{ tool: "check_availability", input: {} }], { id: "second" })
      const agent = agentWith([first, second])

      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.brainsUsed).toEqual(["second", "first"])
      expect(ran).toEqual(["check_availability"])
      expect(sender.texts()).toEqual(["Back again."])
    })
  })

  describe("BRAIN-3: more than one tool call", () => {
    test("BRAIN-3: the first is taken and the rest are dropped", async () => {
      const agent = agentWith([brainAsking(["check_availability", "read_menu"])])

      const result = await agent.receiveAndWait(hello())

      // Only the first ran.
      expect(ran).toEqual(["check_availability"])
      expect(result.turn?.droppedCalls).toEqual(["read_menu"])
    })

    test("BRAIN-3: the dropped ones are named in the trace, beside the one that ran", async () => {
      const agent = agentWith([brainAsking(["check_availability", "read_menu", "read_menu"])])
      await agent.receiveAndWait(hello())

      const row = (await agent.store.events.list({ name: "tool_ran" }))[0]
      expect(row?.props).toMatchObject({ tool: "check_availability", ran: true })
      expect(row?.props["dropped"]).toEqual(["read_menu", "read_menu"])
    })

    test("BRAIN-3: one tool call records nothing as dropped", async () => {
      const agent = agentWith([brainAsking(["check_availability"])])
      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.droppedCalls).toEqual([])
      const row = (await agent.store.events.list({ name: "tool_ran" }))[0]
      expect(row?.props["dropped"]).toBeUndefined()
    })

    test("BRAIN-3: a dropped call is not queued for the next step either", async () => {
      // The brain asked for two things without having seen the result of
      // the first, so the second was decided without it. LOOP-8 step 10
      // gives it that result and lets it ask again.
      const agent = agentWith([brainAsking(["check_availability", "read_menu"])])
      await agent.receiveAndWait(hello())

      expect(ran).toEqual(["check_availability"])
      expect(ran).not.toContain("read_menu")
    })
  })

  describe("BRAIN-4: CLI brains never run in production", () => {
    test("BRAIN-4: a production config naming a CLI brain will not load", async () => {
      expect(() =>
        config({ mode: "production", brain: { id: "claude-code-cli", model: "haiku" } }),
      ).toThrow(/cannot run in production/)
    })

    test("BRAIN-4: nor as a fallback behind an api brain", async () => {
      // The one a config is most likely to get wrong: the primary looks
      // fine and the CLI is further down the list.
      expect(() =>
        config({
          mode: "production",
          brain: {
            id: "openrouter",
            model: "a/b",
            fallbacks: [{ id: "codex-cli", model: "gpt-5-codex" }],
          },
        }),
      ).toThrow(/cannot run in production/)
    })

    test("BRAIN-4: in development it is allowed, which is what it is for", async () => {
      expect(() =>
        config({ mode: "development", brain: { id: "claude-code-cli", model: "haiku" } }),
      ).not.toThrow()
    })

    test("BRAIN-4: an api brain in production is fine", async () => {
      expect(() =>
        config({
          mode: "production",
          brain: { id: "claude-agent-sdk", model: "claude-haiku-4-5" },
        }),
      ).not.toThrow()
    })
  })
})
