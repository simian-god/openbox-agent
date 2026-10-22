// BUILTIN-2: what is still missing from a task, and who gets to decide.
//
// `missingFields` is the whole of BUILTIN-2's second sentence. The brain
// never computes it, so this is the only place it is computed, and a bug
// here is a booking that completes without a date.
import { test, expect, describe } from "bun:test"
import { missingFields, describeTask, taskTools } from "../../src/tools/tasks.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { isBuiltinToolName } from "../../src/tools/builtins.ts"
import { defineBuiltinTool, defineTool, ToolError } from "../../src/tools/define.ts"
import { createToolRegistry } from "../../src/tools/registry.ts"
import { createStore } from "../../src/store/index.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import { z } from "zod"
import type { TaskRow } from "../../src/store/index.ts"

function config(taskTypes: Record<string, unknown> = {}): OpenboxConfig {
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
    taskTypes,
  } as never)
}

const BOOKING = {
  booking: {
    fields: { date: "required", time: "required", size: "required", notes: "optional" },
  },
}

describe("BUILTIN-2: what is still missing", () => {
  test("BUILTIN-2: a required field with no value is missing", () => {
    expect(missingFields(config(BOOKING), "booking", {})).toEqual(["date", "size", "time"])
  })

  test("BUILTIN-2: an optional field is never missing", () => {
    const filled = { date: "2026-10-23", time: "20:00", size: 4 }
    expect(missingFields(config(BOOKING), "booking", filled)).toEqual([])
  })

  test("BUILTIN-2: an empty string has not been found out", () => {
    // A brain that sets a date to "" has not learned the date, and
    // counting that as filled is how a task completes with a hole in it.
    expect(missingFields(config(BOOKING), "booking", { date: "", time: "20:00", size: 4 })).toEqual(
      ["date"],
    )
  })

  test("BUILTIN-2: null and undefined are missing too", () => {
    const fields = { date: null, time: undefined, size: 4 }
    expect(missingFields(config(BOOKING), "booking", fields)).toEqual(["date", "time"])
  })

  test("BUILTIN-2: a zero or a false is a value, not a hole", () => {
    // 0 people is wrong, but it is something the person said, and the
    // tool's own schema is what refuses it. `missing` is about whether a
    // field was answered.
    const types = { survey: { fields: { score: "required", agreed: "required" } } }
    expect(missingFields(config(types), "survey", { score: 0, agreed: false })).toEqual([])
  })

  test("BUILTIN-2: a type nobody declared has nothing required", () => {
    expect(missingFields(config(BOOKING), "no_such_type", {})).toEqual([])
  })

  test("BUILTIN-2: the answer is sorted, so a trace reads the same twice", () => {
    const types = { t: { fields: { zebra: "required", apple: "required", mango: "required" } } }
    expect(missingFields(config(types), "t", {})).toEqual(["apple", "mango", "zebra"])
  })
})

describe("BUILTIN-3: the idle window", () => {
  test("BUILTIN-3: idleHours defaults to 24, as the Spec says", () => {
    const built = config({ booking: { fields: { date: "required" } } })
    expect(built.taskTypes["booking"]?.idleHours).toBe(24)
  })

  test("BUILTIN-3: a type can set its own", () => {
    const built = config({ booking: { fields: { date: "required" }, idleHours: 2 } })
    expect(built.taskTypes["booking"]?.idleHours).toBe(2)
  })
})

describe("BUILTIN-1: the built in tools are the core's, not the agent's", () => {
  const tools = () =>
    taskTools({
      config: config(BOOKING),
      store: createStore({ from: () => ({}) } as never, "restaurant"),
      clock: fixedClock("2026-10-19T06:00:00Z"),
    })

  test("BUILTIN-1: the four task tools are section 10's four", () => {
    expect(tools().map((tool) => tool.name)).toEqual([
      "start_task",
      "update_task",
      "switch_task",
      "close_task",
    ])
    expect(tools().every((tool) => isBuiltinToolName(tool.name))).toBe(true)
  })

  test("BUILTIN-1: each one is marked as built in", () => {
    expect(tools().every((tool) => tool.builtin)).toBe(true)
  })

  test("BUILTIN-1: none of them is gated, so routing and the gate leave them alone", () => {
    // Section 10: only erase_person is gated and confirmed. These four
    // write to the core's own table and cannot do anything in the world.
    expect(tools().every((tool) => tool.risk === "read")).toBe(true)
  })

  test("TOOL-2: they still have to meet every rule an agent tool does", () => {
    for (const tool of tools()) {
      expect(tool.conditions.callWhen.length).toBeGreaterThan(0)
      expect(tool.conditions.dontCallWhen.length).toBeGreaterThan(0)
      expect(tool.examples.should.length).toBeGreaterThan(0)
      expect(tool.examples.shouldNot.length).toBeGreaterThan(0)
      expect(tool.roles).toEqual(["end_user"])
    }
  })

  test("TOOL-2: an agent tool still cannot take a built in name", () => {
    expect(() =>
      defineTool({
        name: "start_task",
        description: "A tool pretending to be a built in.",
        input: z.object({}),
        risk: "read",
        roles: ["end_user"],
        conditions: { callWhen: ["never"], dontCallWhen: ["always"] },
        examples: { should: ["x"], shouldNot: ["y"] },
        handler: async () => ({}),
      }),
    ).toThrow(/built in tool/)
  })

  test("BUILTIN-1: defineBuiltinTool refuses a name section 10 does not list", () => {
    // Otherwise it would be a way to get an ordinary tool exposed on every
    // step without ever passing routing.
    expect(() =>
      defineBuiltinTool({
        name: "do_whatever_i_like",
        description: "Not a built in at all.",
        input: z.object({}),
        risk: "read",
        roles: ["end_user"],
        conditions: { callWhen: ["never"], dontCallWhen: ["always"] },
        examples: { should: ["x"], shouldNot: ["y"] },
        handler: async () => ({}),
      }),
    ).toThrow(ToolError)
  })

  test("BUILTIN-1: the registry keeps them apart from the agent's tools", () => {
    const mine = defineTool({
      name: "check_availability",
      description: "Checks a table.",
      input: z.object({}),
      risk: "read",
      roles: ["end_user"],
      conditions: { callWhen: ["they ask"], dontCallWhen: ["they do not"] },
      examples: { should: ["free?"], shouldNot: ["hello"] },
      handler: async () => ({}),
    })

    const registry = createToolRegistry([mine, ...tools()])

    // LEARN-2 hashes `all()`, so a core upgrade must not change it.
    expect(registry.all().map((tool) => tool.name)).toEqual(["check_availability"])
    expect(registry.builtins()).toHaveLength(4)
    expect(registry.forRole("end_user").map((tool) => tool.name)).toEqual(["check_availability"])
    expect(registry.builtinsForRole("end_user")).toHaveLength(4)
    // And either kind is findable by name, which a confirmation needs.
    expect(registry.get("start_task")?.builtin).toBe(true)
    expect(registry.get("check_availability")?.builtin).toBe(false)
  })

  test("ROLE-3: an operator is offered no task tools, since tasks are an end user's", () => {
    const registry = createToolRegistry(tools())
    expect(registry.builtinsForRole("operator")).toEqual([])
  })
})

describe("what the brain is shown about a task", () => {
  const task: TaskRow = {
    id: "task-1",
    seq: 1,
    agent_id: "restaurant",
    person_id: "p1",
    turn_id: null,
    type: "booking",
    fields: { date: "2026-10-23", size: 4 },
    missing: ["time"],
    status: "active",
    expires_at: "2026-10-20T06:00:00Z",
    closed_at: null,
    created_at: "2026-10-19T06:00:00Z",
    updated_at: "2026-10-19T06:00:00Z",
  }

  test("the description is compact, because it is sent on every turn", () => {
    expect(describeTask(task)).toEqual({
      id: "task-1",
      type: "booking",
      status: "active",
      fields: { date: "2026-10-23", size: 4 },
      missing: ["time"],
    })
  })

  test("it carries no timestamps, which the brain has no use for", () => {
    const keys = Object.keys(describeTask(task))
    expect(keys).not.toContain("expires_at")
    expect(keys).not.toContain("created_at")
  })
})
