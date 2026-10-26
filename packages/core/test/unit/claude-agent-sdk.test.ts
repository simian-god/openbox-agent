// BRAIN-1: the Claude Agent SDK brain.
//
// Checked against the installed package first, as Spec section 23 asks,
// and most of these tests exist because of what that check found. Four of
// the SDK's defaults are wrong for a brain, and three of them fail
// silently: the agent still answers, just shaped by the wrong thing.
//
// Driven through an injected `query`, so the suite needs no SDK, no
// subprocess and no key (TEST-3).
import { test, expect, describe } from "bun:test"
import {
  claudeAgentSdkBrain,
  DEFAULT_CLAUDE_MODEL,
  type SdkQuery,
} from "../../src/providers/brains/claude-agent-sdk.ts"
import { BrainError, type BrainMessage, type BrainTool } from "../../src/providers/brains/types.ts"

const BOOK: BrainTool = {
  name: "book_table",
  description: "Books a table.",
  inputSchema: { type: "object", properties: { size: { type: "number" } } },
}

const input = {
  model: "",
  system: "You are the host.",
  messages: [{ role: "person", text: "a table for four" }] as BrainMessage[],
  tools: [BOOK],
}

/** A fake SDK that answers with one result message. */
function sdkAnswering(result: Record<string, unknown>, extra: unknown[] = []) {
  const calls: { prompt: string; options: Record<string, unknown> }[] = []
  const query: SdkQuery = ({ prompt, options }) => {
    calls.push({ prompt, options: options ?? {} })
    return (async function* () {
      for (const message of extra) yield message
      yield { type: "result", ...result }
    })()
  }
  return { query, calls }
}

const reply = { structured_output: { kind: "reply", text: "We have space." } }

describe("Spec 23: the options the check found have to be set", () => {
  test("BRAIN-1: one turn, which is one user message and one response", async () => {
    const { query, calls } = sdkAnswering(reply)
    await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)

    expect(calls[0]?.options["maxTurns"]).toBe(1)
  })

  test("BRAIN-1: no built in tools, as an allow list of nothing", async () => {
    // The SDK's own type docs say its list of built in tool names "is not
    // complete: the CLI has tools that are not on it, so it cannot stand
    // for every tool". So a deny list cannot be trusted to deny
    // everything, and an allow list of nothing can.
    const { query, calls } = sdkAnswering(reply)
    await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)

    expect(calls[0]?.options["allowedTools"]).toEqual([])
    expect(calls[0]?.options["disallowedTools"]).toBeUndefined()
  })

  test("BRAIN-1: nothing on the machine shapes the answer", async () => {
    // settingSources loads everything when omitted: the developer's
    // ~/.claude/settings.json, the project's .claude/settings.json, its
    // .local variant, and CLAUDE.md. A restaurant agent's replies would
    // then depend on whose laptop it ran on. `[]` is isolation mode.
    const { query, calls } = sdkAnswering(reply)
    await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)

    expect(calls[0]?.options["settingSources"]).toEqual([])
  })

  test("BRAIN-1: the system prompt is a plain string, so the SDK's preset does not apply", async () => {
    const { query, calls } = sdkAnswering(reply)
    await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)

    expect(typeof calls[0]?.options["systemPrompt"]).toBe("string")
    expect(String(calls[0]?.options["systemPrompt"]).startsWith("You are the host.")).toBe(true)
  })

  test("BRAIN-2: the schema is handed over as json_schema", async () => {
    const { query, calls } = sdkAnswering(reply)
    await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)

    const format = calls[0]?.options["outputFormat"] as { type: string; schema: JSONLike }
    expect(format.type).toBe("json_schema")
    // And it is the shared adapter's schema, so `tool` is an enum.
    const properties = format.schema["properties"] as Record<string, Record<string, unknown>>
    expect(properties["tool"]?.["enum"]).toEqual(["book_table"])
  })

  test("CFG-2: the key goes in the environment, with the rest of it kept", async () => {
    // `env` REPLACES the subprocess environment rather than merging, so a
    // brain that passed only the key would take PATH away and the
    // subprocess would not start at all.
    const { query, calls } = sdkAnswering(reply)
    await claudeAgentSdkBrain({ apiKey: "sk-secret", query }).complete(input)

    const env = calls[0]?.options["env"] as Record<string, string>
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-secret")
    expect(Object.keys(env).length).toBeGreaterThan(1)
    expect(env["PATH"] ?? env["Path"]).toBeDefined()
  })

  test("the subprocess runs on Bun, which is the one runtime the core guarantees", async () => {
    // The core only runs on Bun. Letting the SDK pick would mean a brain
    // that works here and cannot start on a server without node.
    const { query, calls } = sdkAnswering(reply)
    await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)

    expect(calls[0]?.options["executable"]).toBe("bun")
  })

  test("a different runtime or executable can be asked for", async () => {
    const { query, calls } = sdkAnswering(reply)
    await claudeAgentSdkBrain({
      apiKey: "sk-test",
      query,
      executable: "node",
      pathToClaudeCodeExecutable: "/opt/claude",
    }).complete(input)

    expect(calls[0]?.options["executable"]).toBe("node")
    expect(calls[0]?.options["pathToClaudeCodeExecutable"]).toBe("/opt/claude")
  })
})

describe("BRAIN-1: what it does with the answer", () => {
  test("BRAIN-2: structured_output on the result becomes the reply", async () => {
    // With json_schema the answer is an attachment on the result, not the
    // last assistant message, which is what the check found.
    const { query } = sdkAnswering(reply, [
      { type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } },
    ])
    const output = await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)

    expect(output.text).toBe("We have space.")
    expect(output.finishReason).toBe("stop")
  })

  test("Spec 23: the last result wins, because the cost on it is cumulative", async () => {
    // The SDK's own docs say a result carries the running total so far and
    // that the latest is the one to read, rather than summing them. So
    // keeping the first result would both answer with stale output and
    // under-report what the call cost.
    const query: SdkQuery = () =>
      (async function* () {
        yield {
          type: "result",
          structured_output: { kind: "reply", text: "half an answer" },
          usage: { input_tokens: 100, output_tokens: 10 },
          total_cost_usd: 0.001,
        }
        yield {
          type: "result",
          structured_output: { kind: "reply", text: "the whole answer" },
          usage: { input_tokens: 300, output_tokens: 40 },
          total_cost_usd: 0.004,
        }
      })()

    const output = await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)

    expect(output.text).toBe("the whole answer")
    expect(output.usage.inputTokens).toBe(300)
    expect(output.usage.costUsd).toBeCloseTo(0.004, 6)
  })

  test("BRAIN-2: a tool answer becomes one toolCalls entry", async () => {
    const { query } = sdkAnswering({
      structured_output: { kind: "tool", tool: "book_table", args: { size: 4 } },
    })
    const output = await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)

    expect(output.toolCalls).toEqual([
      { id: "book_table-1", name: "book_table", input: { size: 4 } },
    ])
  })

  test("C8: a tool the SDK was not offered is still refused, by the shared reader", async () => {
    // The structured output is validated on exactly the same rules as
    // every other brain, which is why it is handed to the shared reader
    // rather than trusted because the SDK produced it.
    const { query } = sdkAnswering({
      structured_output: { kind: "tool", tool: "teleport_the_table", args: {} },
    })

    let thrown: unknown
    try {
      await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)
    } catch (error) {
      thrown = error
    }
    // Asked twice by the shared adapter, then BRAIN-5's error.
    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).message).toContain("teleport_the_table")
  })

  test("LIMIT-3: the tokens and the cost the SDK reports are passed through", async () => {
    const { query } = sdkAnswering({
      ...reply,
      usage: { input_tokens: 1200, output_tokens: 48 },
      total_cost_usd: 0.0031,
    })
    const output = await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)

    expect(output.usage.inputTokens).toBe(1200)
    expect(output.usage.outputTokens).toBe(48)
    expect(output.usage.costUsd).toBeCloseTo(0.0031, 6)
  })

  test("a run that reports no usage is reported as zero, not invented", async () => {
    const { query } = sdkAnswering(reply)
    const output = await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)

    expect(output.usage.inputTokens).toBe(0)
    expect(output.usage.costUsd).toBeUndefined()
  })

  test("LOOP-7: the conversation goes over as a transcript", async () => {
    const { query, calls } = sdkAnswering(reply)
    await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete({
      ...input,
      messages: [
        { role: "person", text: "any space friday?" },
        { role: "operator", text: "I can squeeze you in." },
      ],
    })

    expect(calls[0]?.prompt).toContain("Person: any space friday?")
    // An operator's words are labelled, not passed off as the agent's own.
    expect(calls[0]?.prompt).toContain("A human colleague")
  })

  test("BRAIN-1: the model comes from config, with a pinned fallback", async () => {
    const { query, calls } = sdkAnswering(reply)
    const brain = claudeAgentSdkBrain({ apiKey: "sk-test", query })

    await brain.complete({ ...input, model: "claude-sonnet-4-5" })
    expect(calls[0]?.options["model"]).toBe("claude-sonnet-4-5")

    // Nothing named, so the pinned default rather than whatever the SDK
    // would pick today.
    await brain.complete(input)
    expect(calls[1]?.options["model"]).toBe(DEFAULT_CLAUDE_MODEL)
  })
})

describe("BRAIN-5: when it goes wrong", () => {
  test("BRAIN-5: the SDK giving up on the shape is left to the shared retry", async () => {
    // The SDK retries structured output itself and reports
    // error_max_structured_output_retries. Reported here as text that
    // cannot be read, so one policy decides what happens next rather than
    // two.
    let calls = 0
    const query: SdkQuery = () => {
      calls++
      return (async function* () {
        yield { type: "result", subtype: "error_max_structured_output_retries", is_error: true }
      })()
    }

    let thrown: unknown
    try {
      await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)
    } catch (error) {
      thrown = error
    }

    // Asked twice by the shared adapter, then BRAIN-5's retryable error.
    expect(calls).toBe(2)
    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).retryable).toBe(true)
  })

  test("LOOP-7: a retry still carries the conversation, not just the complaint", async () => {
    // Found by a probe. A retry that sent only the correction would ask
    // the model to fix its formatting with no idea what it was answering,
    // and it would make something up.
    const prompts: string[] = []
    let at = 0
    const query: SdkQuery = ({ prompt }) => {
      prompts.push(prompt)
      at++
      return (async function* () {
        yield at === 1
          ? { type: "result", structured_output: { kind: "nonsense" } }
          : { type: "result", structured_output: { kind: "reply", text: "We have space." } }
      })()
    }

    const output = await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete({
      ...input,
      messages: [{ role: "person", text: "any space friday?" }],
    })

    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("Person: any space friday?")
    expect(prompts[1]).toContain("could not be used")
    expect(output.text).toBe("We have space.")
  })

  test("BRAIN-5: a session that ends with no result at all is an error", async () => {
    const query: SdkQuery = () =>
      (async function* () {
        yield { type: "assistant", message: { content: [] } }
      })()

    await expect(
      claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input),
    ).rejects.toBeInstanceOf(BrainError)
  })

  test("BRAIN-5: an error result with no structured output is an error, not an empty reply", async () => {
    const query: SdkQuery = () =>
      (async function* () {
        yield { type: "result", subtype: "error_during_execution", is_error: true }
      })()

    let thrown: unknown
    try {
      await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).message).toContain("error_during_execution")
  })

  test("BRAIN-5: an error result is retryable, so the step can try the next brain", async () => {
    const query: SdkQuery = () =>
      (async function* () {
        yield { type: "result", subtype: "error_during_execution", is_error: true }
      })()

    try {
      await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete(input)
    } catch (error) {
      expect((error as BrainError).retryable).toBe(true)
    }
  })

  test("the abort signal reaches the SDK as the controller it wants", async () => {
    const { query, calls } = sdkAnswering(reply)
    const controller = new AbortController()
    await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete({
      ...input,
      signal: controller.signal,
    })

    const passed = calls[0]?.options["abortController"] as AbortController
    expect(passed).toBeInstanceOf(AbortController)
    expect(passed.signal.aborted).toBe(false)
    controller.abort("stop")
    expect(passed.signal.aborted).toBe(true)
  })

  test("a signal already aborted arrives aborted", async () => {
    const { query, calls } = sdkAnswering(reply)
    await claudeAgentSdkBrain({ apiKey: "sk-test", query }).complete({
      ...input,
      signal: AbortSignal.abort("too late"),
    })

    expect((calls[0]?.options["abortController"] as AbortController).signal.aborted).toBe(true)
  })
})

describe("BRAIN-1: what kind of brain it is", () => {
  test("BRAIN-1: it says it is an api brain, and it can read images", async () => {
    const { query } = sdkAnswering(reply)
    const brain = claudeAgentSdkBrain({ apiKey: "sk-test", query })

    expect(brain.id).toBe("claude-agent-sdk")
    // BRAIN-1's table says api, and BRAIN-4 therefore allows it in
    // production. It does spawn a subprocess per call, which is the Plan's
    // own latency risk and is written down in the file's own notes.
    expect(brain.kind).toBe("api")
    expect(brain.supportsImages).toBe(true)
  })
})

type JSONLike = Record<string, unknown>
