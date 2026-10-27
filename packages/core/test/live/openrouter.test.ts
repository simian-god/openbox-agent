// The one test that calls OpenRouter for real.
//
// Everything else about this adapter is proven against recorded responses,
// which only shows it matches the documentation. This shows the
// documentation matches OpenRouter.
//
// Skipped unless OPENBOX_LIVE=1 and OPENROUTER_API_KEY are both set, so
// the ordinary suite stays offline (TEST-3) and costs nothing:
//
//   OPENBOX_LIVE=1 OPENROUTER_API_KEY=sk-... bun test packages/core/test/live
import { test, expect, describe } from "bun:test"
import { z } from "zod"
import { openRouterBrain } from "../../src/providers/index.ts"
import { defineTool } from "../../src/tools/index.ts"
import { envOr } from "../../src/env.ts"

const apiKey = process.env["OPENROUTER_API_KEY"]
const live = process.env["OPENBOX_LIVE"] === "1" && apiKey !== undefined && apiKey !== ""

/** Cheap and widely available, so this costs a fraction of a cent. */
const MODEL = envOr("OPENBOX_LIVE_MODEL", "openai/gpt-4o-mini")

describe.skipIf(!live)("BRAIN-1: against the real OpenRouter API", () => {
  const brain = () => openRouterBrain({ apiKey: apiKey as string, appName: "openbox-agent tests" })

  test("BRAIN-1: a plain question comes back as text, with usage and a cost", async () => {
    const output = await brain().complete({
      model: MODEL,
      system: "Answer with a single word.",
      messages: [{ role: "person", text: "What colour is a clear midday sky? One word." }],
      tools: [],
    })

    expect(output.text).toBeTruthy()
    expect(output.finishReason).toBe("stop")
    expect(output.usage.inputTokens).toBeGreaterThan(0)
    expect(output.usage.outputTokens).toBeGreaterThan(0)
    // The docs say cost comes back with no parameter needed. This checks it.
    expect(output.usage.costUsd).toBeGreaterThanOrEqual(0)
  }, 60_000)

  test("BRAIN-1: a tool is offered, called, and its arguments arrive parsed", async () => {
    const tool = defineTool({
      name: "get_weather",
      description: "Looks up the weather in a city.",
      input: z.object({ city: z.string().describe("The city name") }),
      risk: "read",
      roles: ["end_user"],
      conditions: {
        callWhen: ["The person asks about the weather somewhere"],
        dontCallWhen: ["The person is not asking about weather"],
      },
      examples: { should: ["What is it like in Delhi?"], shouldNot: ["Hello"] },
      handler: async () => ({ tempC: 30 }),
    })

    const output = await brain().complete({
      model: MODEL,
      system: "Use the tools you are given when they fit.",
      messages: [{ role: "person", text: "What is the weather in Delhi right now?" }],
      tools: [
        { name: tool.name, description: tool.brainDescription, inputSchema: tool.inputSchema },
      ],
    })

    expect(output.finishReason).toBe("tool_calls")
    expect(output.toolCalls?.[0]?.name).toBe("get_weather")

    // Parsed from the JSON string the API sends, and valid against the schema.
    const parsed = tool.safeParse(output.toolCalls?.[0]?.input)
    expect(parsed.success).toBe(true)
  }, 60_000)

  test("BRAIN-1: a tool result can be sent back and the model replies to it", async () => {
    const output = await brain().complete({
      model: MODEL,
      system: "Answer the person using the tool result you were given.",
      messages: [
        { role: "person", text: "What is the weather in Delhi?" },
        { role: "tool_call", id: "call_1", name: "get_weather", input: { city: "Delhi" } },
        { role: "tool_result", id: "call_1", name: "get_weather", result: { tempC: 30 } },
      ],
      tools: [],
    })

    expect(output.finishReason).toBe("stop")
    expect(output.text).toContain("30")
  }, 60_000)

  test("BRAIN-1: a bad key is reported as not worth retrying", async () => {
    const bad = openRouterBrain({ apiKey: "sk-or-v1-definitely-not-a-real-key" })

    let retryable: boolean | undefined
    try {
      await bad.complete({ model: MODEL, system: "hi", messages: [], tools: [] })
    } catch (error) {
      retryable = (error as { retryable?: boolean }).retryable
    }
    expect(retryable).toBe(false)
  }, 60_000)
})
