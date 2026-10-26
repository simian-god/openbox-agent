// BRAIN-2: the shared adapter for brains with no native tool calling.
//
// Four brains will depend on this, so a bug here is a bug in four of them
// and a test here is worth four tests. Most of these are about the reader,
// because the reader is the part that meets what a model actually sends
// rather than what it was asked for.
//
// The one thing worth being strict about: a tool name that was not offered
// is a shape failure, not an unknown tool. The brain was handed an enum of
// exactly what it could call, so inventing one says the shape was not
// followed, and BRAIN-5 moves on after that happens twice.
import { test, expect, describe } from "bun:test"
import {
  structuredBrain,
  structuredSchema,
  structuredInstructions,
  toTranscript,
  readStructured,
  extractObject,
  REPLY,
  TOOL,
  type StructuredAnswer,
  type StructuredRequest,
} from "../../src/providers/brains/structured.ts"
import { BrainError, type BrainMessage, type BrainTool } from "../../src/providers/brains/types.ts"

const BOOK: BrainTool = {
  name: "book_table",
  description: "Books a table.\n\nCall when:\n- a booking is agreed",
  inputSchema: { type: "object", properties: { size: { type: "number" } }, required: ["size"] },
}
const MENU: BrainTool = {
  name: "read_menu",
  description: "Reads the menu.",
  inputSchema: { type: "object", properties: {} },
}
const TOOLS = [BOOK, MENU]

describe("BRAIN-2: the shape that is asked for", () => {
  test("BRAIN-2: the schema is kind, text, tool and args", () => {
    const schema = structuredSchema(TOOLS)
    const properties = schema["properties"] as Record<string, Record<string, unknown>>

    expect(Object.keys(properties).sort()).toEqual(["args", "kind", "text", "tool"])
    expect(properties["kind"]?.["enum"]).toEqual([REPLY, TOOL])
    expect(schema["required"]).toEqual(["kind"])
    expect(schema["additionalProperties"]).toBe(false)
  })

  test("BRAIN-2: tool is an enum of exactly what was offered", () => {
    // So the provider refuses an invented tool before it reaches us, and
    // C8's first bar costs nothing.
    const properties = structuredSchema(TOOLS)["properties"] as Record<
      string,
      Record<string, unknown>
    >
    expect(properties["tool"]?.["enum"]).toEqual(["book_table", "read_menu"])
  })

  test("BRAIN-2: with no tools offered, there is no tool property at all", () => {
    // Clearer than an empty enum, which some validators refuse outright.
    const schema = structuredSchema([])
    const properties = schema["properties"] as Record<string, Record<string, unknown>>

    expect(Object.keys(properties).sort()).toEqual(["kind", "text"])
    expect(properties["kind"]?.["enum"]).toEqual([REPLY])
  })

  test("BRAIN-2: args is a free object, because the tool's own schema checks it", () => {
    // A schema per tool would need a union, and structured output support
    // for unions varies by provider. LOOP-8 step 6 checks the arguments
    // against the tool's zod schema one step later regardless.
    const properties = structuredSchema(TOOLS)["properties"] as Record<
      string,
      Record<string, unknown>
    >
    expect(properties["args"]?.["type"]).toBe("object")
    expect(properties["args"]?.["additionalProperties"]).toBe(true)
  })
})

describe("BRAIN-2: the instructions that go with it", () => {
  test("BRAIN-2: the shape is spelled out, both forms", () => {
    const text = structuredInstructions(TOOLS)

    expect(text).toContain('{"kind":"reply","text":"..."}')
    expect(text).toContain('{"kind":"tool","tool":"<name>","args":{...}}')
  })

  test("TOOL-3: every tool's description is in the prompt, since there is no tools array", () => {
    const text = structuredInstructions(TOOLS)

    expect(text).toContain("## book_table")
    expect(text).toContain("Call when:")
    expect(text).toContain("## read_menu")
    // And its schema, so the brain knows what args to send.
    expect(text).toContain('"size"')
  })

  test("BRAIN-3: it asks for one tool at a time", () => {
    expect(structuredInstructions(TOOLS)).toContain("One tool at a time")
  })

  test("BRAIN-2: with no tools, it says reply is the only answer there is", () => {
    const text = structuredInstructions([])

    expect(text).toContain("no tools on this step")
    expect(text).not.toContain("## book_table")
  })
})

describe("LOOP-7: the transcript, for a brain that takes one prompt", () => {
  const messages: BrainMessage[] = [
    { role: "person", text: "any space friday?" },
    { role: "agent", text: "for how many?" },
    { role: "operator", text: "I can squeeze you in." },
    { role: "notice", text: "We store your messages." },
    { role: "tool_call", id: "c1", name: "book_table", input: { size: 4 } },
    { role: "tool_result", id: "c1", name: "book_table", result: { booked: true } },
    {
      role: "tool_result",
      id: "c2",
      name: "read_menu",
      result: null,
      error: "the kitchen is shut",
    },
  ]

  test("LOOP-7: each role is labelled as what it was", () => {
    const text = toTranscript(messages)

    expect(text).toContain("Person: any space friday?")
    expect(text).toContain("You: for how many?")
    expect(text).toContain("A human colleague, to the person: I can squeeze you in.")
    expect(text).toContain("Shown to the person by the system: We store your messages.")
  })

  test("LOOP-7: an operator's words are not passed off as the agent's own", () => {
    // The brain has to be able to tell what it said from what a human
    // colleague said, or it will contradict them.
    const text = toTranscript([{ role: "operator", text: "I can squeeze you in." }])
    expect(text).not.toMatch(/^You:/)
  })

  test("LOOP-8: this turn's calls and their results are in it", () => {
    const text = toTranscript(messages)

    expect(text).toContain('You called book_table with {"size":4}')
    expect(text).toContain('book_table returned {"booked":true}')
    expect(text).toContain("read_menu failed: the kitchen is shut")
  })
})

describe("BRAIN-2: reading what a model actually sent", () => {
  test("BRAIN-2: a reply becomes text", () => {
    const read = readStructured('{"kind":"reply","text":"We open at 11."}', TOOLS)

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.output.text).toBe("We open at 11.")
    expect(read.output.finishReason).toBe("stop")
    expect(read.output.toolCalls).toBeUndefined()
  })

  test("BRAIN-2: a tool becomes one toolCalls entry", () => {
    const read = readStructured('{"kind":"tool","tool":"book_table","args":{"size":4}}', TOOLS)

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.output.toolCalls).toEqual([
      { id: "book_table-1", name: "book_table", input: { size: 4 } },
    ])
    expect(read.output.finishReason).toBe("tool_calls")
  })

  test("BRAIN-2: a tool with no args is a call with no args, not a failure", () => {
    const read = readStructured('{"kind":"tool","tool":"read_menu"}', TOOLS)

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.output.toolCalls?.[0]?.input).toEqual({})
  })

  test("BRAIN-2: a fenced answer is read, because models fence JSON", () => {
    const read = readStructured('```json\n{"kind":"reply","text":"hello"}\n```', TOOLS)
    expect(read.ok).toBe(true)
  })

  test("BRAIN-2: a fence wins over braces in the prose before it", () => {
    // This is the case the fence handling is for, and a probe found it was
    // untested: without the fence, scanning from the first brace finds
    // "{my plan}", which does not parse, and a good answer is thrown away.
    const answer = [
      "Here is {my plan}:",
      "",
      "```json",
      '{"kind":"reply","text":"We open at 11."}',
      "```",
    ].join("\n")

    const read = readStructured(answer, TOOLS)

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.output.text).toBe("We open at 11.")
  })

  test("BRAIN-2: prose around the object is read past", () => {
    // Refusing these would mean falling back to another brain over
    // formatting, which costs a person their answer for nothing.
    const read = readStructured(
      'Sure, here is my answer:\n\n{"kind":"reply","text":"hello"}\n\nLet me know!',
      TOOLS,
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.output.text).toBe("hello")
  })

  test("BRAIN-2: a nested object survives, and a brace in a string does not end it early", () => {
    const read = readStructured(
      '{"kind":"tool","tool":"book_table","args":{"size":4,"note":"table } by the window"}}',
      TOOLS,
    )

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.output.toolCalls?.[0]?.input).toEqual({
      size: 4,
      note: "table } by the window",
    })
  })

  test("BRAIN-2: no JSON at all is a shape failure, and says so", () => {
    const read = readStructured("I think we are open at eleven.", TOOLS)

    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problem).toContain("no JSON object")
    // And it keeps what was sent, so a builder can see the real answer.
    expect(read.found).toContain("eleven")
  })

  test("BRAIN-2: JSON that does not parse is a shape failure", () => {
    const read = readStructured('{"kind":"reply","text":}', TOOLS)

    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problem).toContain("did not parse")
  })

  test("BRAIN-2: an answer wrapped in an array is still read", () => {
    // Deliberate, and it took a contradictory test of mine to see it. A
    // model that wraps the object in a list has sent the right answer in
    // the wrong envelope, and falling back to another brain over an
    // envelope costs a person their reply for nothing.
    const read = readStructured('[{"kind":"reply","text":"hello"}]', TOOLS)

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.output.text).toBe("hello")
  })

  test("BRAIN-2: a JSON value that is not an object at all is a shape failure", () => {
    expect(readStructured('"just a string"', TOOLS).ok).toBe(false)
    expect(readStructured("42", TOOLS).ok).toBe(false)
    expect(readStructured("null", TOOLS).ok).toBe(false)
  })

  test("BRAIN-2: a kind that is neither reply nor tool is a shape failure", () => {
    const read = readStructured('{"kind":"thinking","text":"hmm"}', TOOLS)

    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problem).toContain("thinking")
  })

  test("BRAIN-2: a reply with no text is a shape failure, not an empty answer", () => {
    // LOOP-8 step 4 treats an empty reply as `no_reply` and ends the turn
    // having said nothing. Better to ask again.
    const read = readStructured('{"kind":"reply","text":"   "}', TOOLS)

    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problem).toContain("text was empty")
  })

  test("BRAIN-2: a tool with no name is a shape failure", () => {
    const read = readStructured('{"kind":"tool","args":{"size":4}}', TOOLS)

    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problem).toContain("no tool was named")
  })

  test("C8: a tool that was not offered is a shape failure, and names what was", () => {
    // The brain was given an enum of exactly what it could call, so this
    // says the shape was not followed. LOOP-8 step 5 is for a brain that
    // calls what it was not shown; this never gets that far.
    const read = readStructured('{"kind":"tool","tool":"teleport_the_table","args":{}}', TOOLS)

    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problem).toContain("teleport_the_table")
    expect(read.problem).toContain("book_table, read_menu")
  })

  test("BRAIN-2: args that are not an object is a shape failure", () => {
    const read = readStructured('{"kind":"tool","tool":"read_menu","args":"everything"}', TOOLS)

    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.problem).toContain("args was not an object")
  })

  test("BRAIN-2: what was sent is shortened, so an error stays readable", () => {
    const read = readStructured("x".repeat(5000), TOOLS)

    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.found.length).toBeLessThan(400)
    expect(read.found).toContain("5000 characters")
  })

  test("extractObject: the outermost object, not the first brace it sees", () => {
    expect(extractObject('prose {"a":{"b":1}} more')).toBe('{"a":{"b":1}}')
    expect(extractObject("no object here")).toBeNull()
    expect(extractObject('{"unclosed":')).toBeNull()
  })
})

describe("BRAIN-2 and BRAIN-5: the brain the adapter builds", () => {
  /** A brain that answers with whatever text it is told to, in order. */
  function brainSaying(...answers: (string | StructuredAnswer)[]) {
    const asked: StructuredRequest[] = []
    let at = 0
    const brain = structuredBrain({
      id: "test-brain",
      kind: "api",
      ask: async (request) => {
        asked.push(request)
        const answer = answers[Math.min(at, answers.length - 1)]
        at++
        return typeof answer === "string" ? { text: answer } : (answer as StructuredAnswer)
      },
    })
    return { brain, asked }
  }

  const input = {
    model: "test/model",
    system: "You are the host.",
    messages: [{ role: "person", text: "any space friday?" }] as BrainMessage[],
    tools: TOOLS,
  }

  test("BRAIN-2: it is a Brain, and it answers like one", async () => {
    const { brain } = brainSaying('{"kind":"reply","text":"We open at 11."}')
    const output = await brain.complete(input)

    expect(brain.id).toBe("test-brain")
    expect(brain.kind).toBe("api")
    expect(output.text).toBe("We open at 11.")
  })

  test("BRAIN-2: the ask gets the schema, the instructions and a transcript", async () => {
    const { brain, asked } = brainSaying('{"kind":"reply","text":"hi"}')
    await brain.complete(input)

    const request = asked[0]
    expect(request?.schema["properties"]).toBeDefined()
    // The agent's prompt first, then the shape, so a provider that caches
    // a prefix still can.
    expect(request?.system.startsWith("You are the host.")).toBe(true)
    expect(request?.system).toContain("# How to answer")
    expect(request?.transcript).toContain("Person: any space friday?")
    expect(request?.tools).toEqual(TOOLS)
  })

  test("BRAIN-5: a wrong shape is asked again, with what was wrong", async () => {
    const { brain, asked } = brainSaying(
      "I think we are open at eleven.",
      '{"kind":"reply","text":"We open at 11."}',
    )
    const output = await brain.complete(input)

    expect(asked).toHaveLength(2)
    expect(asked[1]?.correction).toContain("no JSON object")
    expect(output.text).toBe("We open at 11.")
  })

  test("BRAIN-5: the correction is its own field, not folded into the system prompt", async () => {
    // So a provider that caches the system prompt keeps the cache, and a
    // brain with a better place for a correction can use it.
    const { brain, asked } = brainSaying("nonsense", '{"kind":"reply","text":"ok"}')
    await brain.complete(input)

    expect(asked[0]?.system).toBe(asked[1]?.system)
    expect(asked[0]?.correction).toBeUndefined()
  })

  test("BRAIN-5: twice in a row is a BrainError, so the step falls back", async () => {
    const { brain, asked } = brainSaying("nonsense", "still nonsense")

    let thrown: unknown
    try {
      await brain.complete(input)
    } catch (error) {
      thrown = error
    }

    expect(asked).toHaveLength(2)
    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).retryable).toBe(true)
    // And it says what the model sent, which is the only way to debug it.
    expect((thrown as BrainError).message).toContain("still nonsense")
  })

  test("BRAIN-5: retries can be turned off for a brain that should not get two goes", async () => {
    const asked: StructuredRequest[] = []
    const brain = structuredBrain({
      id: "one-shot",
      kind: "cli",
      retries: 0,
      ask: async (request) => {
        asked.push(request)
        return { text: "nonsense" }
      },
    })

    await expect(brain.complete(input)).rejects.toBeInstanceOf(BrainError)
    expect(asked).toHaveLength(1)
  })

  test("LIMIT-3: both attempts are counted, because both were paid for", async () => {
    const { brain } = brainSaying(
      { text: "nonsense", usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.001 } },
      {
        text: '{"kind":"reply","text":"ok"}',
        usage: { inputTokens: 120, outputTokens: 12, costUsd: 0.002 },
      },
    )
    const output = await brain.complete(input)

    expect(output.usage.inputTokens).toBe(220)
    expect(output.usage.outputTokens).toBe(22)
    expect(output.usage.costUsd).toBeCloseTo(0.003, 6)
  })

  test("a provider that reports no usage is reported as zero, not invented", async () => {
    const { brain } = brainSaying('{"kind":"reply","text":"ok"}')
    const output = await brain.complete(input)

    expect(output.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(output.usage.costUsd).toBeUndefined()
  })

  test("BRAIN-2: a thrown ask is left to the caller, not retried as a shape problem", async () => {
    // A provider that is down is BRAIN-5's business, and retrying it here
    // would double every outage.
    let calls = 0
    const brain = structuredBrain({
      id: "down",
      kind: "api",
      ask: async () => {
        calls++
        throw new BrainError("down", "502 from the provider", true)
      },
    })

    await expect(brain.complete(input)).rejects.toBeInstanceOf(BrainError)
    expect(calls).toBe(1)
  })

  test("BRAIN-2: a step with no tools asks for a reply only", async () => {
    const { brain, asked } = brainSaying('{"kind":"reply","text":"ok"}')
    await brain.complete({ ...input, tools: [] })

    const kind = (asked[0]?.schema["properties"] as Record<string, Record<string, unknown>>)["kind"]
    expect(kind?.["enum"]).toEqual([REPLY])
    expect(asked[0]?.system).toContain("no tools on this step")
  })

  test("BRAIN-2: the abort signal is passed through", async () => {
    const { brain, asked } = brainSaying('{"kind":"reply","text":"ok"}')
    const controller = new AbortController()
    await brain.complete({ ...input, signal: controller.signal })

    expect(asked[0]?.signal).toBe(controller.signal)
  })
})
