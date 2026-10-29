// K14, step 1: a failing integration test says what the agent was waiting
// on, not just which array was wrong.
//
// Named after the Known row rather than a Spec ID, because the subject is
// the suite itself. K14 is two intermittent stalls in this suite, and the
// reason neither has been root caused is that the failure prints a short
// list, which looks the same whether the message never arrived, another
// process took it, or the pump never ran.
import { test, expect, describe, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents, stillRunning } from "../support/agents.ts"
import { check, waiting } from "../support/waiting.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool } from "../../src/tools/index.ts"
import { scriptedBrain } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel } from "../../src/testing/scripted-decision.ts"
import { fakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import type { Agent } from "../../src/runtime/index.ts"

const agents = trackAgents("waiting.test.ts")

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

const look = defineTool({
  name: "check_availability",
  description: "Checks whether a table is free.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask about a table"], dontCallWhen: ["they do not"] },
  examples: { should: ["any space?"], shouldNot: ["hello"] },
  handler: async () => ({ free: true }),
})

describeDatabase("what the agent was waiting on", (sql) => {
  const clock = fixedClock("2026-10-19T06:00:00Z")

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  function agent(): Agent {
    return agents.create({
      config: config(),
      deps: {
        brains: [scriptedBrain([{ tool: "check_availability" }, { reply: "Yes, come at eight." }])],
        decisionModel: scriptedDecisionModel([]),
        db: localSupabase(),
        sender: fakeSender(),
        clock,
      },
      prompt: "You are the host at a restaurant.",
      tools: [look],
    })
  }

  const hello = {
    channel: "whatsapp",
    channelUserId: "42",
    channelMessageId: "m1",
    text: "any space on monday?",
  }

  test("K14: a passing assertion is left alone", async () => {
    const here = agent()
    const result = await here.receiveAndWait(hello)

    // No throw, and nothing added to anything.
    await check(here, undefined, () => {
      expect(result.turn?.outcome).toBe("replied")
    })
  })

  test("K14: a failing assertion keeps its message and adds the state", async () => {
    const here = agent()
    const result = await here.receiveAndWait(hello)

    let message = ""
    try {
      await check(here, undefined, () => {
        expect(result.turn?.outcome).toBe("step_cap")
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    // The original failure, word for word.
    expect(message).toContain("step_cap")
    // Then what the agent was holding when it failed.
    expect(message).toContain("what the agent was waiting on:")
    expect(message).toContain("turn(s) in flight")
    expect(message).toContain("outbox pump busy")
    // And the rows, which is the part that tells a stall from a theft.
    expect(message).toContain("m1 done")
    expect(message).toMatch(/reply:[0-9a-f]+ sent after 1 attempt/)
  })

  test("K14: the state names every row, inbox, outbox, jobs and leases", async () => {
    const here = agent()
    const result = await here.receiveAndWait(hello)
    const person = (await here.store.people.list())[0]

    const state = await waiting(here, person?.id)

    expect(state).toContain(`agent restaurant as ${here.owner}`)
    expect(state).toContain("inbox:")
    expect(state).toContain("outbox:")
    expect(state).toContain("jobs:")
    expect(state).toContain("leases:")
    // LOOP-2: the lease this turn held, and who held it.
    expect(state).toContain(`held by ${here.owner}`)
    expect(result.turn?.outcome).toBe("replied")
  })

  test("K14: a database that cannot be read does not hide the failure", async () => {
    // The database may be the thing that is wrong, and then reading it
    // fails too. The failure being reported has to survive that.
    const broken = {
      config: { name: "broken" },
      owner: "nobody",
      inFlight: () => 0,
      outbox: { pump: { busy: () => 0, running: true } },
      jobs: { pump: { busy: () => 0, running: true } },
      store: {
        inbox: { list: () => Promise.reject(new Error("the database is gone")) },
        outbox: { list: () => Promise.reject(new Error("the database is gone")) },
        jobs: { list: () => Promise.reject(new Error("the database is gone")) },
        leases: { list: () => Promise.reject(new Error("the database is gone")) },
      },
    } as unknown as Agent

    let message = ""
    try {
      await check(broken, undefined, () => {
        expect(1).toBe(2)
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain("the state could not be read")
    expect(message).toContain("the database is gone")
  })

  describe("K14, step 2: the registry", () => {
    test("K14: an agent that will not stop is reported, with its file", async () => {
      const here = agent()
      // The one thing a registry cannot fix by trying harder.
      const real = here.stop.bind(here)
      here.stop = () => Promise.reject(new Error("the lease would not go back"))

      await expect(agents.stopAll()).rejects.toThrow(/waiting\.test\.ts: 1 agent\(s\)/)
      // And it is not left behind to fail every later test for this.
      expect(stillRunning()).toEqual([])

      // Then really stop it, or its poll timer is the very leak this
      // registry exists to catch.
      here.stop = real
      await real()
    })
  })
})
