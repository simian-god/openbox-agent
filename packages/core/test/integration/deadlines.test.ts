// BRAIN-6, LOOP-10 and Known K3: what happens when somebody else never
// answers.
//
// Three waits used to have no end. A brain that never replied held the
// turn, and `stop()` waits for the turns in flight, so a shutdown waited
// with it (K3). A tool had a timeout in the Spec and nothing enforcing
// it. A decision request had a timer and nothing to cancel with, so the
// request stayed in flight, still billed (K10).
//
// Small millisecond deadlines rather than a frozen clock, because a
// deadline is about real elapsed time. The helper itself says why.
import { test, expect, describe, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import type { Agent, AgentOptions } from "../../src/runtime/index.ts"
import { WANTS_HUMAN } from "../../src/runtime/handover.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool, type Tool } from "../../src/tools/index.ts"
import { scriptedBrain } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import type { Brain, BrainOutput } from "../../src/providers/brains/types.ts"

const PROMPT = "You are the host at a restaurant."
const agents = trackAgents("deadlines.test.ts")

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
    workerPollMs: 25,
    ...over,
  } as never)
}

/**
 * A brain that never answers, and records whether it was cancelled.
 *
 * It waits on the signal rather than on a timer, so the test does not
 * depend on how long anything takes: either the signal aborts and this
 * rejects, or the test times out and says so.
 */
function hangingBrain(id = "hanging") {
  const aborted: unknown[] = []
  const brain: Brain = {
    id,
    kind: "api",
    supportsImages: false,
    complete: (input) =>
      new Promise<BrainOutput>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => {
          aborted.push(input.signal?.reason)
          reject(new Error("aborted"))
        })
      }),
  }
  return { brain, aborted }
}

/** A tool that never returns. */
const slowTool = (): Tool =>
  defineTool({
    name: "check_availability",
    description: "Checks whether a table is free.",
    input: z.object({}),
    risk: "read",
    roles: ["end_user"],
    conditions: { callWhen: ["they ask about a table"], dontCallWhen: ["they do not"] },
    examples: { should: ["any space?"], shouldNot: ["hello"] },
    handler: () => new Promise(() => {}),
  })

describeDatabase("deadlines", (sql) => {
  let sender: FakeSender

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  function agentWith(
    brains: Brain[],
    over: Record<string, unknown> = {},
    tools: Tool[] = [],
  ): Agent {
    sender = fakeSender()
    const build: AgentOptions = {
      config: config(over),
      deps: {
        brains,
        decisionModel: scriptedDecisionModel([
          { [WANTS_HUMAN]: yesno(0), [GATE_QUESTION]: yesno(1) },
        ]),
        db: localSupabase(),
        sender,
        clock: { now: () => new Date() },
      },
      prompt: PROMPT,
      tools,
    }
    return agents.create(build)
  }

  const hello = (over: Record<string, unknown> = {}) => ({
    channel: "whatsapp",
    channelUserId: "42",
    channelMessageId: `m-${Math.random()}`,
    text: "any space on monday?",
    ...over,
  })

  describe("BRAIN-6: a brain that never answers", () => {
    test("BRAIN-6: it is given up on, and the request is cancelled", async () => {
      // K10's other half, on the brain. A request given up on and left in
      // flight is still billed and still holds a connection.
      const { brain, aborted } = hangingBrain()
      const agent = agentWith([brain], { brainTimeoutMs: 60 })

      await agent.receiveAndWait(hello())

      expect(aborted).toHaveLength(1)
      expect((aborted[0] as Error).name).toBe("Timeout")
    })

    test("BRAIN-5 and BRAIN-6: the next brain answers, so the person still does", async () => {
      // A slow provider and a broken one look the same to the person, so
      // they are treated the same: the step moves on.
      const { brain } = hangingBrain()
      const working = scriptedBrain([{ reply: "We open at 11." }], { id: "working" })
      const agent = agentWith([brain, working], {
        brainTimeoutMs: 60,
        brain: {
          id: "openrouter",
          model: "slow/one",
          fallbacks: [{ id: "openrouter", model: "ok/one" }],
        },
      })

      const result = await agent.receiveAndWait(hello())

      expect(sender.texts()).toEqual(["We open at 11."])
      expect(result.turn?.brainsUsed).toEqual(["working"])
    })

    test("LOOP-12: a turn whose only brain hangs ends, rather than hanging with it", async () => {
      const { brain } = hangingBrain()
      const agent = agentWith([brain], { brainTimeoutMs: 60 })

      const result = await agent.receiveAndWait(hello())

      expect(result.turn?.outcome).toBe("brains_failed")
      // LOOP-12 still applies: the person is told, and a colleague too.
      expect(sender.texts().length).toBeGreaterThan(0)
    })

    test("BRAIN-6: zero means no deadline, so a builder can turn it off", async () => {
      // Proven by a brain that answers slowly and is still heard, rather
      // than by waiting on a hang that would never end.
      const slow: Brain = {
        id: "slow",
        kind: "api",
        supportsImages: false,
        complete: async () => {
          await new Promise((resolve) => setTimeout(resolve, 80))
          return {
            text: "Took a while, sorry.",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          }
        },
      }
      const agent = agentWith([slow], { brainTimeoutMs: 0 })

      await agent.receiveAndWait(hello())

      expect(sender.texts()).toEqual(["Took a while, sorry."])
    })
  })

  describe("LOOP-10: a tool that never returns", () => {
    test("LOOP-10: the turn stops waiting and the brain is told, in words it can use", async () => {
      const brain = scriptedBrain(
        [{ tool: "check_availability" }, { reply: "I could not check just now." }],
        { id: "asking" },
      )
      const agent = agentWith([brain], { toolTimeoutMs: 60 }, [slowTool()])

      await agent.receiveAndWait(hello())

      expect(sender.texts()).toEqual(["I could not check just now."])
      const runs = await agent.store.toolRuns.list({}, { orderBy: "seq" })
      expect(runs[0]?.status).toBe("error")
      expect(String(runs[0]?.error)).toContain("took too long")
    })

    test("LOOP-10: the trace says it timed out, not that it failed obscurely", async () => {
      const brain = scriptedBrain([{ tool: "check_availability" }, { reply: "Sorry." }], {
        id: "asking",
      })
      const agent = agentWith([brain], { toolTimeoutMs: 60 }, [slowTool()])

      await agent.receiveAndWait(hello())

      const events = await agent.store.events.list({ name: "tool_ran" }, { orderBy: "seq" })
      const failed = events.find((row) => (row.props as { ok?: boolean }).ok === false)
      expect(String((failed?.props as { error?: string }).error)).toContain("took too long")
    })

    // LEARN-1 says "any tool error or timeout", and both arrive at the
    // same place because `withDeadline` throws. The flag records which,
    // since a timeout is usually somebody else's system being slow and an
    // error is usually the tool.
    test("LEARN-1: a tool that times out raises a tool_error flag marked as a timeout", async () => {
      const brain = scriptedBrain([{ tool: "check_availability" }, { reply: "Sorry." }], {
        id: "asking",
      })
      const agent = agentWith([brain], { toolTimeoutMs: 60 }, [slowTool()])

      await agent.receiveAndWait(hello())

      const [flag] = await agent.store.flags.list({ kind: "tool_error" }, { orderBy: "seq" })
      expect(flag).toBeDefined()
      expect(flag?.detail).toMatchObject({ tool: "check_availability", timeout: true })
      expect(String((flag?.detail as { error?: string }).error)).toContain("took too long")
    })
  })

  describe("K3: stopping while something will not finish", () => {
    test("K3: stop() returns rather than waiting for ever", async () => {
      // The whole of K3. Before this, a brain that never answered held the
      // turn, and `stop()` waits for the turns in flight, so a shutdown
      // waited with it. The brain here ignores its signal on purpose: a
      // wait nothing can cancel is the case `stop()` has to survive.
      // Releasable on purpose, and that is the whole lesson of this test.
      //
      // The first version held for ever, so `stop()` gave up, the agent
      // kept running, and it claimed other test files' people and never
      // answered them. Sixteen tests failed in files that have nothing to
      // do with deadlines. `stop()` having a deadline means it can return
      // while work is in flight, and the shared agent registry drops its
      // entry once `stop()` resolves, so `stillRunning()` cannot see it
      // either (Known K27). A test that leaves one behind poisons the run.
      let release: () => void = () => {}
      const stuck: Brain = {
        id: "stuck",
        kind: "api",
        supportsImages: false,
        complete: () =>
          new Promise<BrainOutput>((resolve) => {
            release = () =>
              resolve({
                text: "Finally.",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
              })
          }),
      }
      const reported: unknown[] = []
      sender = fakeSender()
      const agent = agents.build({
        config: config({ brainTimeoutMs: 0, stopTimeoutMs: 80 }),
        deps: {
          brains: [stuck],
          decisionModel: scriptedDecisionModel([
            { [WANTS_HUMAN]: yesno(0), [GATE_QUESTION]: yesno(1) },
          ]),
          db: localSupabase(),
          sender,
          clock: { now: () => new Date() },
        },
        prompt: PROMPT,
        tools: [],
        onWorkerError: (error) => reported.push(error),
      })
      agent.start()

      await agent.receive(hello())
      // Let the worker pick it up and reach the brain.
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(agent.inFlight()).toBe(1)

      await agent.stop()

      // It gave up rather than draining, and said so instead of throwing:
      // `stop()` runs in cleanup hooks and in signal handlers, where a
      // throw turns a slow exit into a crash.
      expect(reported).toHaveLength(1)
      expect(String((reported[0] as Error).message)).toContain("gave up")
      expect(String((reported[0] as Error).message)).toContain("1 turn(s) still in flight")

      // Let it go and stop it for real, so nothing is left polling the
      // database that every other test file shares.
      release()
      await agent.stop()
      expect(agent.inFlight()).toBe(0)
    })

    test("K3: a shutdown that can drain still drains, and reports nothing", async () => {
      const reported: unknown[] = []
      sender = fakeSender()
      const agent = agents.build({
        config: config({ stopTimeoutMs: 5_000 }),
        deps: {
          brains: [scriptedBrain([{ reply: "We open at 11." }])],
          decisionModel: scriptedDecisionModel([
            { [WANTS_HUMAN]: yesno(0), [GATE_QUESTION]: yesno(1) },
          ]),
          db: localSupabase(),
          sender,
          clock: { now: () => new Date() },
        },
        prompt: PROMPT,
        tools: [],
        onWorkerError: (error) => reported.push(error),
      })
      agent.start()

      await agent.receiveAndWait(hello())
      await agent.stop()

      expect(sender.texts()).toEqual(["We open at 11."])
      expect(reported).toEqual([])
    })
  })
})
