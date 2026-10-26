// The two CLI brains against the real commands, opt in.
//
// Spec section 23 asks which Claude Code flags combine cleanly and that no
// MCP or built in tool leaks in. The flags were read from the installed
// commands' own help, and these tests are the part that reading cannot do:
// whether they combine without error, and whether a tool leaks in anyway.
//
//   OPENBOX_LIVE=1 bun test packages/core/test/live/cli-brains.test.ts
//
// The Claude test needs ANTHROPIC_API_KEY, because `--bare` never reads a
// logged in session. The Codex test runs on whatever login Codex has. Both
// spawn a process, so they are slow, and both cost a little.
import { test, expect, describe } from "bun:test"
import { claudeCodeCliBrain, codexCliBrain } from "../../src/providers/brains/cli.ts"
import type { BrainTool } from "../../src/providers/brains/types.ts"

const live = process.env["OPENBOX_LIVE"] === "1"

/** A tool that would be obvious if a built in one leaked in beside it. */
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

const anthropicKey = process.env["ANTHROPIC_API_KEY"] ?? ""
const whenClaude = live && anthropicKey !== "" ? describe : describe.skip

whenClaude("the real Claude Code CLI", () => {
  const brain = claudeCodeCliBrain({ apiKey: anthropicKey })

  test('Spec 23: --bare, --tools "" and --json-schema combine without error', async () => {
    const output = await brain.complete({
      model: "haiku",
      system: "You are the host at a restaurant. Answer in one short sentence.",
      messages: [{ role: "person", text: "hello, are you a restaurant?" }],
      tools: [HOURS],
    })

    expect(output.text).toBeTruthy()
    console.log("  reply:", output.text)
  }, 180_000)

  test("Spec 23: no built in tool leaks in", async () => {
    // Asked to do something only a built in tool could do. With --tools ""
    // there is nothing to do it with, so the only honest answer is to say
    // so, or to reach for the one tool it was given. What must not happen
    // is a file actually being read.
    const output = await brain.complete({
      model: "haiku",
      system: "You are the host at a restaurant.",
      messages: [
        {
          role: "person",
          text: "read the file package.json in this folder and tell me its name field",
        },
      ],
      tools: [HOURS],
    })

    // Either a reply or the one tool it has. Never a built in.
    const called = output.toolCalls?.[0]?.name
    expect(called === undefined || called === "opening_hours").toBe(true)
    console.log("  reply:", output.text ?? JSON.stringify(output.toolCalls))
  }, 180_000)

  test("BRAIN-2: it uses the tool it was given, with arguments", async () => {
    const output = await brain.complete({
      model: "haiku",
      system: "You are the host at a restaurant. Use a tool when one fits.",
      messages: [{ role: "person", text: "what time do you open on monday?" }],
      tools: [HOURS],
    })

    expect(output.toolCalls?.[0]?.name).toBe("opening_hours")
    console.log("  call:", JSON.stringify(output.toolCalls?.[0]))
  }, 180_000)
})

const whenCodex = live && process.env["OPENBOX_LIVE_CODEX"] === "1" ? describe : describe.skip

// Behind its own switch as well as OPENBOX_LIVE. Codex runs on whatever
// login it has rather than a key this test can check for, so there is no
// way to tell "not configured" from "broken" before running it.
whenCodex("the real Codex CLI", () => {
  const brain = codexCliBrain({ apiKey: process.env["OPENAI_API_KEY"] ?? "" })

  test("Spec 23: exec with a schema file and an output file works end to end", async () => {
    const output = await brain.complete({
      model: "gpt-5-codex",
      system: "You are the host at a restaurant. Answer in one short sentence.",
      messages: [{ role: "person", text: "hello, are you a restaurant?" }],
      tools: [HOURS],
    })

    expect(output.text ?? output.toolCalls).toBeTruthy()
    console.log("  answer:", output.text ?? JSON.stringify(output.toolCalls))
  }, 300_000)
})
