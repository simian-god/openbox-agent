// BRAIN-1 lists five brains. Only OpenRouter is built in M1, so only
// OpenRouter is proven here. The other four arrive in M5, and T5.6 runs
// one scripted conversation across all of them.
//
// The OpenRouter tests use recorded responses in the shape its docs
// describe, so the suite stays offline (TEST-3). test/live holds the one
// test that calls the real API.
import { test, expect, describe } from "bun:test"
import { z } from "zod"
import { openRouterBrain, toWireMessages, readResponse } from "../../src/providers/index.ts"
import type { FetchLike } from "../../src/providers/brains/openrouter.ts"
import { BrainError, type BrainMessage } from "../../src/providers/brains/types.ts"
import { scriptedBrain } from "../../src/testing/scripted-brain.ts"
import { defineTool } from "../../src/tools/index.ts"

/** A recorded reply, in the shape OpenRouter's docs describe. */
const REPLY_RESPONSE = {
  id: "gen-123",
  choices: [
    { index: 0, finish_reason: "stop", message: { role: "assistant", content: "Booked." } },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128, cost: 0.000216 },
}

/** A recorded tool call. Arguments come back as a JSON string. */
const TOOL_CALL_RESPONSE = {
  id: "gen-124",
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      native_finish_reason: "function_call",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: {
              name: "create_booking",
              arguments: '{"date":"2026-10-20","time":"20:00","size":4}',
            },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 200, completion_tokens: 25, total_tokens: 225, cost: 0.0004 },
}

/** A fetch that answers from a canned payload and records the request. */
function fakeFetch(payload: unknown, init: { status?: number } = {}) {
  const requests: { url: string; headers: Record<string, string>; body: unknown }[] = []

  const call: FetchLike = async (url, options) => {
    requests.push({
      url: String(url),
      headers: (options?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(options?.body ?? "{}")),
    })
    return new Response(JSON.stringify(payload), {
      status: init.status ?? 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  return { call, requests }
}

const brainWith = (payload: unknown, status?: number) => {
  const { call, requests } = fakeFetch(payload, status === undefined ? {} : { status })
  return { brain: openRouterBrain({ apiKey: "test-key", fetch: call }), requests }
}

const emptyInput = { model: "some/model", system: "You are a host.", messages: [], tools: [] }

describe("BRAIN-1: the OpenRouter brain", () => {
  test("BRAIN-1: it declares itself as an api brain that takes images", () => {
    const brain = openRouterBrain({ apiKey: "k" })

    expect(brain.id).toBe("openrouter")
    expect(brain.kind).toBe("api")
    expect(brain.supportsImages).toBe(true)
  })

  test("BRAIN-1: a reply comes back as text with its usage and cost", async () => {
    const { brain } = brainWith(REPLY_RESPONSE)
    const output = await brain.complete(emptyInput)

    expect(output.text).toBe("Booked.")
    expect(output.toolCalls).toBeUndefined()
    expect(output.finishReason).toBe("stop")
    expect(output.usage).toEqual({ inputTokens: 120, outputTokens: 8, costUsd: 0.000216 })
  })

  test("BRAIN-1: a tool call comes back parsed, not as a JSON string", async () => {
    const { brain } = brainWith(TOOL_CALL_RESPONSE)
    const output = await brain.complete(emptyInput)

    expect(output.finishReason).toBe("tool_calls")
    expect(output.toolCalls).toEqual([
      {
        id: "call_abc",
        name: "create_booking",
        input: { date: "2026-10-20", time: "20:00", size: 4 },
      },
    ])
  })

  test("BRAIN-1: tools are sent in the shape the API expects", async () => {
    const tool = defineTool({
      name: "create_booking",
      description: "Books a table.",
      input: z.object({ size: z.number().int() }),
      risk: "write",
      roles: ["end_user"],
      conditions: { callWhen: ["a size is known"], dontCallWhen: ["only asking"] },
      examples: { should: ["book for 4"], shouldNot: ["are you open?"] },
      handler: async () => null,
    })

    const { brain, requests } = brainWith(REPLY_RESPONSE)
    await brain.complete({
      ...emptyInput,
      tools: [
        { name: tool.name, description: tool.brainDescription, inputSchema: tool.inputSchema },
      ],
    })

    const body = requests[0]?.body as {
      tools: { type: string; function: { name: string; parameters: unknown } }[]
      tool_choice: string
    }
    expect(body.tools[0]?.type).toBe("function")
    expect(body.tools[0]?.function.name).toBe("create_booking")
    expect(body.tools[0]?.function.parameters).toMatchObject({
      type: "object",
      properties: { size: { type: "integer" } },
    })
    expect(body.tool_choice).toBe("auto")
  })

  test("BRAIN-1: no tools means no tools field, rather than an empty one", async () => {
    const { brain, requests } = brainWith(REPLY_RESPONSE)
    await brain.complete(emptyInput)

    expect(requests[0]?.body).not.toHaveProperty("tools")
    expect(requests[0]?.body).not.toHaveProperty("tool_choice")
  })

  test("BRAIN-1: the system prompt leads the messages", async () => {
    const { brain, requests } = brainWith(REPLY_RESPONSE)
    await brain.complete({ ...emptyInput, messages: [{ role: "person", text: "hello" }] })

    const body = requests[0]?.body as { messages: { role: string; content: string }[] }
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a host." })
    expect(body.messages[1]).toEqual({ role: "user", content: "hello" })
  })

  test("BRAIN-1: the key travels in the Authorization header, never the body", async () => {
    const { brain, requests } = brainWith(REPLY_RESPONSE)
    await brain.complete(emptyInput)

    expect(requests[0]?.headers["Authorization"]).toBe("Bearer test-key")
    expect(JSON.stringify(requests[0]?.body)).not.toContain("test-key")
  })

  test("BRAIN-1: an http error becomes a BrainError saying whether to retry", async () => {
    for (const [status, retryable] of [
      [429, true],
      [500, true],
      [503, true],
      [401, false],
      [400, false],
    ] as [number, boolean][]) {
      const { brain } = brainWith({ error: { message: "nope" } }, status)
      let caught: BrainError | undefined
      try {
        await brain.complete(emptyInput)
      } catch (error) {
        caught = error as BrainError
      }

      expect(caught).toBeInstanceOf(BrainError)
      expect(caught?.retryable).toBe(retryable)
      expect(caught?.message).toContain(String(status))
    }
  })

  test("BRAIN-1: a network failure is retryable, so the next brain is tried", async () => {
    const brain = openRouterBrain({
      apiKey: "k",
      fetch: async () => {
        throw new Error("connection reset")
      },
    })

    let caught: BrainError | undefined
    try {
      await brain.complete(emptyInput)
    } catch (error) {
      caught = error as BrainError
    }
    expect(caught?.retryable).toBe(true)
  })
})

describe("BRAIN-1: reading a response", () => {
  test("BRAIN-1: an error payload with a 200 is still an error", () => {
    expect(() => readResponse({ error: { message: "rate limited" } })).toThrow(BrainError)
  })

  test("BRAIN-1: a response with no choices is an error, not an empty reply", () => {
    expect(() => readResponse({ choices: [] })).toThrow(/no choices/)
  })

  test("BRAIN-1: unparsable arguments are kept rather than thrown away", () => {
    const output = readResponse({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "c1", function: { name: "book", arguments: "{not json" } }],
          },
        },
      ],
    })

    // The core rejects it at LOOP-8 step 6 and tells the brain what it sent.
    expect(output.toolCalls?.[0]?.input).toEqual({ __unparsed: "{not json" })
  })

  test("BRAIN-1: a missing cost is left out rather than reported as zero", () => {
    const output = readResponse({
      choices: [{ finish_reason: "stop", message: { content: "hi" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    })

    expect(output.usage.costUsd).toBeUndefined()
    expect(output.usage).toEqual({ inputTokens: 1, outputTokens: 2 })
  })

  test("BRAIN-1: the provider's own finish reason is used when there is no normalised one", () => {
    const output = readResponse({
      choices: [{ native_finish_reason: "end_turn", message: { content: "hi" } }],
    })
    expect(output.finishReason).toBe("end_turn")
  })
})

describe("BRAIN-1: mapping the history", () => {
  test("BRAIN-1: each kind of message maps to a role the API has", () => {
    const messages: BrainMessage[] = [
      { role: "person", text: "Can I book?" },
      { role: "agent", text: "For how many?" },
      { role: "operator", text: "We are full tonight." },
      { role: "notice", text: "We store your messages." },
      { role: "tool_call", id: "c1", name: "check", input: { date: "today" } },
      { role: "tool_result", id: "c1", name: "check", result: { free: 2 } },
    ]

    const wire = toWireMessages(messages)

    expect(wire[0]).toEqual({ role: "user", content: "Can I book?" })
    expect(wire[1]).toEqual({ role: "assistant", content: "For how many?" })
    // A human's words are marked, so the brain does not read them as its own.
    expect(wire[2]).toMatchObject({ role: "assistant" })
    expect((wire[2] as { content: string }).content).toContain("human colleague")
    expect(wire[3]).toMatchObject({ role: "system" })
    expect(wire[4]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "check" } }],
    })
    expect(wire[5]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"free":2}' })
  })

  test("BRAIN-1: a failed tool reports the error to the brain", () => {
    const wire = toWireMessages([
      { role: "tool_result", id: "c1", name: "check", result: null, error: "timed out" },
    ])
    expect(wire[0]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"error":"timed out"}' })
  })

  test("BRAIN-1: a tool call's arguments go out as a JSON string", () => {
    const wire = toWireMessages([{ role: "tool_call", id: "c1", name: "check", input: { a: 1 } }])
    const call = wire[0] as { tool_calls: { function: { arguments: string } }[] }

    expect(typeof call.tool_calls[0]?.function.arguments).toBe("string")
    expect(JSON.parse(call.tool_calls[0]?.function.arguments as string)).toEqual({ a: 1 })
  })
})

describe("TEST-3: the scripted brain", () => {
  test("TEST-3: the core's tests need no network or key", async () => {
    const brain = scriptedBrain([{ reply: "Hello." }])
    const output = await brain.complete(emptyInput)

    expect(output.text).toBe("Hello.")
    expect(output.finishReason).toBe("stop")
  })

  test("TEST-3: it answers the script in order", async () => {
    const brain = scriptedBrain([
      { tool: "create_booking", input: { size: 4 } },
      { reply: "Done." },
    ])

    const first = await brain.complete(emptyInput)
    expect(first.toolCalls).toEqual([
      { id: "call_create_booking", name: "create_booking", input: { size: 4 } },
    ])
    expect(first.finishReason).toBe("tool_calls")

    expect((await brain.complete(emptyInput)).text).toBe("Done.")
  })

  test("TEST-3: it records what it was asked, so a test can check the context", async () => {
    const brain = scriptedBrain([{ reply: "ok" }])
    await brain.complete({
      ...emptyInput,
      system: "You are a dentist.",
      messages: [{ role: "person", text: "hi" }],
    })

    expect(brain.calls).toHaveLength(1)
    expect(brain.calls[0]?.system).toBe("You are a dentist.")
    expect(brain.calls[0]?.messages).toEqual([{ role: "person", text: "hi" }])
  })

  test("TEST-3: it can fail on purpose, to prove the fallback chain", async () => {
    const brain = scriptedBrain([{ throws: "overloaded", retryable: true }])

    let caught: BrainError | undefined
    try {
      await brain.complete(emptyInput)
    } catch (error) {
      caught = error as BrainError
    }
    expect(caught).toBeInstanceOf(BrainError)
    expect(caught?.retryable).toBe(true)
  })

  test("TEST-3: running out of script never hangs a test", async () => {
    const brain = scriptedBrain([{ reply: "one" }])
    await brain.complete(emptyInput)

    const output = await brain.complete(emptyInput)
    expect(output.finishReason).toBe("stop")
    expect(output.text).toBeTruthy()
  })

  test("TEST-3: the last step can repeat, for a loop that must be cut off", async () => {
    const brain = scriptedBrain([{ tool: "search" }], { whenExhausted: "repeat-last" })

    for (let i = 0; i < 3; i++) {
      expect((await brain.complete(emptyInput)).finishReason).toBe("tool_calls")
    }
  })

  test("TEST-3: more steps can be queued part way through", async () => {
    const brain = scriptedBrain([{ reply: "first" }])
    expect((await brain.complete(emptyInput)).text).toBe("first")

    brain.push({ reply: "second" })
    expect((await brain.complete(emptyInput)).text).toBe("second")
  })
})

describe("MEDIA-2: images on the wire", () => {
  // Checked against OpenRouter's own API reference on 2026-10-27 rather
  // than a mirror, because two mirrors disagreed. The image part is
  // `{ type: "image_url", image_url: { url } }` and the url takes a plain
  // https URL as well as a data: URL.
  test("MEDIA-2: a message with no images stays a plain string", () => {
    const wire = toWireMessages([{ role: "person", text: "Can I book?" }])

    expect(wire[0]).toEqual({ role: "user", content: "Can I book?" })
  })

  test("MEDIA-2: a picture becomes an image_url part beside the text", () => {
    const wire = toWireMessages([
      {
        role: "person",
        text: "is this still on?",
        images: [{ ref: "https://m/pic.jpg", mime: "image/jpeg" }],
      },
    ])

    expect(wire[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "is this still on?" },
        { type: "image_url", image_url: { url: "https://m/pic.jpg" } },
      ],
    })
  })

  test("MEDIA-2: a photo with no caption sends the picture and no empty text part", () => {
    const wire = toWireMessages([
      { role: "person", text: "", images: [{ ref: "https://m/pic.jpg", mime: "image/jpeg" }] },
    ])

    expect(wire[0]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://m/pic.jpg" } }],
    })
  })

  test("MEDIA-2: several pictures are several parts, in order", () => {
    const wire = toWireMessages([
      {
        role: "person",
        text: "these two",
        images: [
          { ref: "https://m/a.jpg", mime: "image/jpeg" },
          { ref: "https://m/b.png", mime: "image/png" },
        ],
      },
    ])

    const content = (wire[0] as { content: { image_url?: { url: string } }[] }).content
    expect(content.map((part) => part.image_url?.url)).toEqual([
      undefined,
      "https://m/a.jpg",
      "https://m/b.png",
    ])
  })

  test("MEDIA-2: a data URL in the ref goes through untouched", () => {
    // The way out for a channel whose media needs an auth header: the
    // provider does the fetching, so the ref has to be something it can
    // reach, and a data URL always is (Known K25).
    const data = "data:image/png;base64,iVBORw0KGgo="
    const wire = toWireMessages([
      { role: "person", text: "", images: [{ ref: data, mime: "image/png" }] },
    ])

    expect(wire[0]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: data } }],
    })
  })

  test("MEDIA-2: this brain says it can read pictures", () => {
    expect(openRouterBrain({ apiKey: "sk-test" }).supportsImages).toBe(true)
  })
})
