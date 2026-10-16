import { test, expect, describe } from "bun:test"
import { z } from "zod"
import {
  defineTool,
  createToolRegistry,
  ToolError,
  BUILTIN_TOOL_NAMES,
} from "../../src/tools/index.ts"

/** A complete, valid tool definition for tests to bend. */
function validInput(): Record<string, unknown> {
  return {
    name: "create_booking",
    description: "Books a table.",
    input: z.object({
      date: z.string(),
      time: z.string(),
      size: z.number().int().min(1),
    }),
    risk: "write",
    roles: ["end_user"],
    conditions: {
      callWhen: ["The person has given a date, time and party size"],
      dontCallWhen: ["The person is only asking about availability"],
    },
    examples: {
      should: ["Book me a table for 4 tomorrow at 8"],
      shouldNot: ["Are you open tomorrow?"],
    },
    handler: async () => ({ ok: true }),
  }
}

/** The problems reported, as one string. */
function problems(input: unknown): string {
  try {
    // biome-ignore lint: the point of the call is to be rejected
    defineTool(input as never)
  } catch (error) {
    if (error instanceof ToolError) return error.problems.join("\n")
    throw error
  }
  throw new Error("expected the tool to be rejected, but it was accepted")
}

describe("TOOL-1: what a tool is made of", () => {
  test("TOOL-1: a complete definition is accepted and keeps its fields", () => {
    const tool = defineTool(validInput() as never)

    expect(tool.name).toBe("create_booking")
    expect(tool.description).toBe("Books a table.")
    expect(tool.risk).toBe("write")
    expect(tool.roles).toEqual(["end_user"])
    expect(tool.conditions.callWhen).toHaveLength(1)
  })

  test("TOOL-1: the zod input becomes a JSON schema the brain can use", () => {
    const tool = defineTool(validInput() as never)

    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: {
        date: { type: "string" },
        time: { type: "string" },
        size: { type: "integer", minimum: 1 },
      },
      required: ["date", "time", "size"],
      // Strict tool calling needs this, or a brain can invent arguments.
      additionalProperties: false,
    })
  })

  test("TOOL-1: the JSON schema carries no $schema key, which some providers reject", () => {
    const tool = defineTool(validInput() as never)
    expect(tool.inputSchema).not.toHaveProperty("$schema")
  })

  test("TOOL-1: field descriptions survive into the JSON schema", () => {
    const input = validInput()
    input["input"] = z.object({ date: z.string().describe("The day, as YYYY-MM-DD") })
    const tool = defineTool(input as never)

    expect(tool.inputSchema).toMatchObject({
      properties: { date: { description: "The day, as YYYY-MM-DD" } },
    })
  })

  test("TOOL-1: arguments are validated against the tool's own schema", () => {
    const tool = defineTool(validInput() as never)

    expect(tool.parse({ date: "2026-10-20", time: "20:00", size: 4 })).toEqual({
      date: "2026-10-20",
      time: "20:00",
      size: 4,
    })
    expect(tool.safeParse({ date: "2026-10-20", time: "20:00", size: 0 }).success).toBe(false)
    expect(tool.safeParse({ date: "2026-10-20" }).success).toBe(false)
  })

  test("TOOL-1: the handler is kept and runs", async () => {
    const tool = defineTool(validInput() as never)
    const result = await tool.handler(
      { date: "x", time: "y", size: 1 } as never,
      {
        clock: { now: () => new Date(0) },
      } as never,
    )

    expect(result).toEqual({ ok: true })
  })

  test("TOOL-1: the input must be an object schema, since arguments arrive as objects", () => {
    const input = validInput()
    input["input"] = z.string()
    expect(problems(input)).toContain("input")
  })
})

describe("TOOL-2: registration rules", () => {
  test("TOOL-2: rejects a tool with no callWhen conditions", () => {
    const input = validInput()
    input["conditions"] = { callWhen: [], dontCallWhen: ["x"] }
    expect(problems(input)).toContain("callWhen")
  })

  test("TOOL-2: rejects a tool with no dontCallWhen conditions", () => {
    const input = validInput()
    input["conditions"] = { callWhen: ["x"], dontCallWhen: [] }
    expect(problems(input)).toContain("dontCallWhen")
  })

  test("TOOL-2: a blank condition does not count as a condition", () => {
    const input = validInput()
    input["conditions"] = { callWhen: ["   "], dontCallWhen: ["x"] }
    expect(problems(input)).toContain("callWhen")
  })

  test("TOOL-2: rejects a tool with no roles", () => {
    const input = validInput()
    input["roles"] = []
    expect(problems(input)).toContain("roles")
  })

  test("TOOL-2: rejects an unknown role", () => {
    const input = validInput()
    input["roles"] = ["manager"]
    expect(problems(input)).toContain("roles")
  })

  test("TOOL-2: rejects a tool with no should examples", () => {
    const input = validInput()
    input["examples"] = { should: [], shouldNot: ["x"] }
    expect(problems(input)).toContain("examples.should")
  })

  test("TOOL-2: rejects a tool with no shouldNot examples", () => {
    const input = validInput()
    input["examples"] = { should: ["x"], shouldNot: [] }
    expect(problems(input)).toContain("examples.shouldNot")
  })

  test("TOOL-2: rejects an irreversible tool with no confirmSummary", () => {
    const input = validInput()
    input["risk"] = "irreversible"
    expect(problems(input)).toContain("confirmSummary")
  })

  test("TOOL-2: accepts an irreversible tool that has a confirmSummary", () => {
    const input = validInput()
    input["risk"] = "irreversible"
    input["confirmSummary"] = (args: { size: number }) => `Table for ${args.size}`
    const tool = defineTool(input as never)

    expect(tool.risk).toBe("irreversible")
    expect(tool.confirmSummary?.({ size: 4 } as never)).toBe("Table for 4")
  })

  test("TOOL-2: a read or write tool needs no confirmSummary", () => {
    for (const risk of ["read", "write"]) {
      const input = validInput()
      input["risk"] = risk
      expect(() => defineTool(input as never)).not.toThrow()
    }
  })

  test("TOOL-2: rejects an unknown risk level", () => {
    const input = validInput()
    input["risk"] = "dangerous"
    expect(problems(input)).toContain("risk")
  })

  test("TOOL-2: rejects a name that clashes with a built in tool", () => {
    for (const builtin of BUILTIN_TOOL_NAMES) {
      const input = validInput()
      input["name"] = builtin
      const reported = problems(input)
      expect(reported).toContain(builtin)
      expect(reported).toContain("built in")
    }
  })

  test("TOOL-2: rejects a name a brain cannot call", () => {
    for (const name of ["", "create booking", "create/booking", "a".repeat(65)]) {
      const input = validInput()
      input["name"] = name
      expect(problems(input)).toContain("name")
    }
  })

  test("TOOL-2: rejects a tool with no description, since the brain reads it", () => {
    const input = validInput()
    input["description"] = "  "
    expect(problems(input)).toContain("description")
  })

  test("TOOL-2: every problem is reported at once", () => {
    const input = validInput()
    input["roles"] = []
    input["risk"] = "irreversible"
    input["conditions"] = { callWhen: [], dontCallWhen: [] }

    const reported = problems(input)
    expect(reported).toContain("roles")
    expect(reported).toContain("callWhen")
    expect(reported).toContain("dontCallWhen")
    expect(reported).toContain("confirmSummary")
  })
})

describe("TOOL-3: the description the brain sees", () => {
  test("TOOL-3: it is the description, then call when, then don't call when", () => {
    const input = validInput()
    input["description"] = "Books a table."
    input["conditions"] = {
      callWhen: ["The person gave a date and a time", "The party size is known"],
      dontCallWhen: ["They are only asking about availability"],
    }

    expect(defineTool(input as never).brainDescription).toBe(
      [
        "Books a table.",
        "",
        "Call when:",
        "- The person gave a date and a time",
        "- The party size is known",
        "",
        "Don't call when:",
        "- They are only asking about availability",
      ].join("\n"),
    )
  })

  test("TOOL-3: the conditions appear in the order they were written", () => {
    const input = validInput()
    input["conditions"] = {
      callWhen: ["first", "second", "third"],
      dontCallWhen: ["no"],
    }
    const text = defineTool(input as never).brainDescription

    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"))
    expect(text.indexOf("second")).toBeLessThan(text.indexOf("third"))
  })
})

describe("the registry", () => {
  const booking = () => defineTool(validInput() as never)
  const named = (name: string, over: Record<string, unknown> = {}) =>
    defineTool({ ...validInput(), name, ...over } as never)

  test("TOOL-2: the registry finds a tool by name", () => {
    const registry = createToolRegistry([booking()])

    expect(registry.get("create_booking")?.name).toBe("create_booking")
    expect(registry.get("nope")).toBeUndefined()
    expect(registry.all()).toHaveLength(1)
  })

  test("TOOL-2: the registry rejects two tools with the same name", () => {
    expect(() => createToolRegistry([booking(), booking()])).toThrow(ToolError)

    try {
      createToolRegistry([booking(), booking()])
    } catch (error) {
      expect((error as ToolError).problems.join("\n")).toContain("create_booking")
    }
  })

  test("TOOL-2: the registry keeps the order tools were given in", () => {
    const registry = createToolRegistry([named("a_tool"), named("b_tool")])
    expect(registry.all().map((tool) => tool.name)).toEqual(["a_tool", "b_tool"])
  })

  test("TOOL-2: the registry lists the tools a role may use", () => {
    const registry = createToolRegistry([
      named("for_user", { roles: ["end_user"] }),
      named("for_operator", { roles: ["operator"] }),
      named("for_both", { roles: ["end_user", "operator"] }),
    ])

    expect(registry.forRole("end_user").map((tool) => tool.name)).toEqual(["for_user", "for_both"])
    expect(registry.forRole("operator").map((tool) => tool.name)).toEqual([
      "for_operator",
      "for_both",
    ])
  })

  test("TOOL-2: an empty registry is allowed, since an agent may start with no tools", () => {
    expect(createToolRegistry([]).all()).toEqual([])
  })
})
