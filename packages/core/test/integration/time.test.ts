// C15's second half, on real turns: "a request outside opening hours is
// refused by tool code even when the brain tries."
//
// The brain here is scripted to do the wrong thing on purpose, because
// that is the only way to prove the tool is what refuses. A test where the
// brain behaves itself proves nothing about who is holding the line.
import { test, expect, describe, beforeAll, beforeEach, afterEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { migrate } from "../../src/migrate/index.ts"
import {
  createAgent as buildAgent,
  type Agent,
  type AgentOptions,
} from "../../src/runtime/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool } from "../../src/tools/index.ts"
import { scriptedBrain, type ScriptedBrain } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"

const PROMPT = "You are the host at a restaurant."

const started: Agent[] = []

function createAgent(options: AgentOptions): Agent {
  const agent = buildAgent({ secret: "test-secret", ...options })
  agent.start()
  started.push(agent)
  return agent
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((agent) => agent.stop()))
})

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: {
      mon: [
        ["11:00", "15:00"],
        ["19:00", "23:00"],
      ],
      tue: [
        ["11:00", "15:00"],
        ["19:00", "23:00"],
      ],
      wed: [
        ["11:00", "15:00"],
        ["19:00", "23:00"],
      ],
      thu: [
        ["11:00", "15:00"],
        ["19:00", "23:00"],
      ],
      fri: [
        ["11:00", "15:00"],
        ["19:00", "23:30"],
      ],
      sat: [["11:00", "23:30"]],
      sun: [],
    },
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

/** Every booking the handler actually accepted. */
let accepted: { at: string }[] = []

/**
 * TIME-3: a tool whose time input is the words the person said.
 *
 * Note what it does not take: a date. The brain cannot hand this tool a
 * day it worked out, because there is nowhere to put one.
 */
const requestTable = defineTool({
  name: "request_table",
  description: "Asks for a table at a time the person said.",
  input: z.object({
    when: z.string().min(1).describe("The words the person used, like 'tomorrow 8pm'"),
    size: z.number().int().min(1),
  }),
  risk: "read",
  roles: ["end_user"],
  conditions: {
    callWhen: ["The person has said when they want a table and for how many"],
    dontCallWhen: ["They have not said when"],
  },
  examples: { should: ["a table for four tomorrow at 8"], shouldNot: ["what time do you open?"] },
  handler: async (args, ctx) => {
    // TIME-3: the tool resolves the phrase, in code.
    const when = ctx.time.resolve(args.when)
    if (when.kind === "ambiguous") {
      return { ok: false, ambiguous: true, why: when.why, candidates: when.candidates }
    }

    // And checks the hours, in code. Whatever the brain believes.
    if (!ctx.time.isOpen(when.at)) {
      const next = ctx.time.nextOpen(when.at)
      return {
        ok: false,
        closed: true,
        asked: ctx.time.format(when.at),
        nextOpen: next === null ? null : ctx.time.format(next),
      }
    }

    accepted.push({ at: when.at.toISOString() })
    return { ok: true, at: ctx.time.format(when.at) }
  },
})

describeDatabase("time on a real turn", (sql) => {
  let sender: FakeSender
  // Monday 19 October 2026, 11:30 in Kolkata.
  const clock = fixedClock("2026-10-19T06:00:00Z")

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
    accepted = []
    // The clock is shared by every test in this file and two of them move
    // it. Reset here rather than at the end of those tests: a test that
    // fails never reaches its own cleanup, and the next one then fails for
    // a reason that has nothing to do with it.
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
      tools: [requestTable],
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

  test("C15: a booking inside opening hours is accepted", async () => {
    const { agent, brain } = agentWith([
      { tool: "request_table", input: { when: "tomorrow 8pm", size: 4 } },
      { reply: "Done." },
    ])
    await agent.receiveAndWait(says("a table for four tomorrow at 8", "m1"))

    expect(resultOf(brain, 1)["ok"]).toBe(true)
    expect(accepted).toHaveLength(1)
    // Tuesday 20 October at 20:00 in Kolkata.
    expect(accepted[0]?.at).toBe("2026-10-20T14:30:00.000Z")
  })

  test("C15: a booking outside opening hours is refused by the tool", async () => {
    // 17:00 is between lunch and dinner.
    const { agent, brain } = agentWith([
      { tool: "request_table", input: { when: "tomorrow 5pm", size: 4 } },
      { reply: "We are closed then." },
    ])
    await agent.receiveAndWait(says("a table for four tomorrow at 5", "m1"))

    const result = resultOf(brain, 1)
    expect(result["ok"]).toBe(false)
    expect(result["closed"]).toBe(true)
    expect(result["nextOpen"]).toBe("Tuesday 20 October at 19:00")
    expect(accepted).toEqual([])
  })

  test("C15: the tool refuses even when the brain insists", async () => {
    // The brain is told no and tries the same time again, twice. This is
    // the test that proves the tool is holding the line rather than the
    // model's good manners.
    const { agent, brain } = agentWith([
      { tool: "request_table", input: { when: "25 October at 8pm", size: 2 } },
      { tool: "request_table", input: { when: "25 October at 8pm", size: 2 } },
      { tool: "request_table", input: { when: "25 October at 8pm", size: 2 } },
      { reply: "I am afraid we are closed on Sundays." },
    ])
    await agent.receiveAndWait(says("the 25th at 8 please, i know you can do it", "m1"))

    for (const call of [1, 2, 3]) {
      expect(resultOf(brain, call)["closed"]).toBe(true)
    }
    expect(accepted).toEqual([])
  })

  test("TIME-3: a tool input holds the words, so the brain cannot smuggle a date in", async () => {
    // The only field for a time is a string of what the person said. A
    // brain that sends a date it worked out sends it as a phrase, and the
    // tool resolves that phrase itself.
    const { agent, brain } = agentWith([
      { tool: "request_table", input: { when: "2026-10-25T20:00:00Z", size: 2 } },
      { reply: "Let me check." },
    ])
    await agent.receiveAndWait(says("sunday at 8", "m1"))

    // Read as a date by the tool, in the agent's zone, and Sunday is shut.
    expect(resultOf(brain, 1)["ok"]).toBe(false)
    expect(accepted).toEqual([])
  })

  test("TIME-3: an ambiguous phrase goes back to the brain to ask about", async () => {
    const { agent, brain } = agentWith([
      { tool: "request_table", input: { when: "friday", size: 4 } },
      { reply: "What time on Friday?" },
    ])
    await agent.receiveAndWait(says("friday please", "m1"))

    const result = resultOf(brain, 1)
    expect(result["ambiguous"]).toBe(true)
    expect(String(result["why"])).toContain("no time of day")
    expect(accepted).toEqual([])
  })

  test("TIME-4: the brain is told today's and tomorrow's dates, and not to work them out", async () => {
    const { agent, brain } = agentWith([{ reply: "Hello." }])
    await agent.receiveAndWait(says("hello", "m1"))

    const system = brain.calls[0]?.system ?? ""
    expect(system).toContain("Date: 2026-10-19 (Monday)")
    expect(system).toContain("Tomorrow: 2026-10-20 (Tuesday)")
    expect(system).toContain("Never work out a date yourself")
  })

  test("TIME-1: the agent's timezone decides the day, not the server's", async () => {
    // 19:00Z is already Tuesday the 20th in Kolkata and still Monday in
    // London. The same instant, the same phrase, two different answers,
    // and the agent's config is what picks.
    clock.set("2026-10-19T19:00:00Z")

    const here = agentWith([
      { tool: "request_table", input: { when: "tomorrow 8pm", size: 2 } },
      { reply: "ok" },
    ])
    await here.agent.receiveAndWait(says("tomorrow at 8", "m1"))
    const inKolkata = accepted[0]?.at

    accepted = []
    const london = agentWith(
      [{ tool: "request_table", input: { when: "tomorrow 8pm", size: 2 } }, { reply: "ok" }],
      { timezone: "Europe/London" },
    )
    await london.agent.receiveAndWait(says("tomorrow at 8", "m2"))
    const inLondon = accepted[0]?.at

    // Wednesday the 21st at 20:00 in Kolkata.
    expect(inKolkata).toBe("2026-10-21T14:30:00.000Z")
    // Tuesday the 20th at 20:00 in London.
    expect(inLondon).toBe("2026-10-20T19:00:00.000Z")
  })

  describe("TOOL-4: what a handler is given", () => {
    test("TOOL-4: ctx.time is there, and frozen with the turn's clock", async () => {
      let sawNow: string | undefined
      const peek = defineTool({
        name: "peek",
        description: "Reports what the context gave it.",
        input: z.object({}),
        risk: "read",
        roles: ["end_user"],
        conditions: { callWhen: ["a test asks"], dontCallWhen: ["never"] },
        examples: { should: ["peek"], shouldNot: ["hello"] },
        handler: async (_args, ctx) => {
          sawNow = ctx.clock.now().toISOString()
          return {
            hasResolve: typeof ctx.time.resolve === "function",
            hasIsOpen: typeof ctx.time.isOpen === "function",
            hasNextOpen: typeof ctx.time.nextOpen === "function",
            hasFormat: typeof ctx.time.format === "function",
            // Resolved through the context, so this is the agent's zone.
            tomorrow: ctx.time.resolve("tomorrow 8pm"),
          }
        },
      })

      const brain = scriptedBrain([{ tool: "peek", input: {} }, { reply: "ok" }])
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
        tools: [peek],
      })

      await agent.receiveAndWait(says("peek", "m1"))

      const result = resultOf(brain, 1)
      expect(result["hasResolve"]).toBe(true)
      expect(result["hasIsOpen"]).toBe(true)
      expect(result["hasNextOpen"]).toBe(true)
      expect(result["hasFormat"]).toBe(true)
      expect(sawNow).toBe("2026-10-19T06:00:00.000Z")
      const tomorrow = result["tomorrow"] as { kind: string; at: string }
      expect(tomorrow.kind).toBe("exact")
      expect(new Date(tomorrow.at).toISOString()).toBe("2026-10-20T14:30:00.000Z")
    })
  })
})
