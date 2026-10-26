// One live call to the real Claude Agent SDK, opt in.
//
// Everything else about this brain is proven against an injected `query`,
// which is the right way round: a suite that needed a subprocess and a key
// would not run in CI and would stop being run here. But the four options
// the section 23 check turned up are claims about somebody else's package,
// and recorded fixtures cannot tell us the day one of them changes.
//
// So this one exists to be run by hand, now and then:
//
//   OPENBOX_LIVE=1 bun test packages/core/test/live/claude-agent-sdk.test.ts
//
// It needs ANTHROPIC_API_KEY and it spawns a subprocess, so it is slow and
// it costs a fraction of a cent.
import { test, expect, describe } from "bun:test"
import { claudeAgentSdkBrain } from "../../src/providers/brains/claude-agent-sdk.ts"
import type { BrainTool } from "../../src/providers/brains/types.ts"

const live = process.env["OPENBOX_LIVE"] === "1"
const apiKey = process.env["ANTHROPIC_API_KEY"] ?? ""
const when = live && apiKey !== "" ? describe : describe.skip

const HOURS: BrainTool = {
  name: "opening_hours",
  description:
    "Says when the restaurant is open.\n\nCall when:\n- the person asks about opening times\n\nDon't call when:\n- the person asks about anything else",
  inputSchema: {
    type: "object",
    properties: { day: { type: "string" } },
    required: ["day"],
    additionalProperties: false,
  },
}

when("the real Claude Agent SDK", () => {
  const brain = claudeAgentSdkBrain({ apiKey })

  test("BRAIN-2: it answers in the shape, and the shape is a reply", async () => {
    const output = await brain.complete({
      model: "claude-haiku-4-5",
      system: "You are the host at a restaurant. Answer in one short sentence.",
      messages: [{ role: "person", text: "hello, are you a restaurant?" }],
      tools: [HOURS],
    })

    expect(output.text).toBeTruthy()
    expect(output.toolCalls).toBeUndefined()
    console.log("  reply:", output.text)
    console.log("  usage:", JSON.stringify(output.usage))
  }, 120_000)

  test("BRAIN-2: it calls the one tool it was offered, with arguments", async () => {
    const output = await brain.complete({
      model: "claude-haiku-4-5",
      system: "You are the host at a restaurant. Use a tool when one fits.",
      messages: [{ role: "person", text: "what time do you open on monday?" }],
      tools: [HOURS],
    })

    expect(output.toolCalls?.[0]?.name).toBe("opening_hours")
    console.log("  call:", JSON.stringify(output.toolCalls?.[0]))
  }, 120_000)

  test("Spec 23: the usage and cost the SDK really reports", async () => {
    // Printed rather than asserted on exact numbers. What matters is
    // whether the fields are there at all, which is the thing recorded
    // fixtures cannot tell us.
    const output = await brain.complete({
      model: "claude-haiku-4-5",
      system: "You are the host at a restaurant.",
      messages: [{ role: "person", text: "thanks!" }],
      tools: [],
    })

    console.log("  usage:", JSON.stringify(output.usage))
    expect(output.usage.inputTokens).toBeGreaterThan(0)
  }, 120_000)
})
