// BRAIN-1 and BRAIN-4: the Claude Code and Codex CLI brains.
//
// The flags were checked against the installed commands first, as Spec
// section 23 asks, and most of these tests pin a flag that the check
// turned up. A flag quietly dropped is the kind of fault that leaves the
// agent working and wrong: it still answers, with your CLAUDE.md in its
// head or with its tools switched on.
//
// Driven through an injected `run`, so the suite needs neither CLI, no
// subprocess and no key (TEST-3).
import { test, expect, describe } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  claudeCodeCliBrain,
  codexCliBrain,
  unwrap,
  DEFAULT_CLAUDE_CLI_MODEL,
  DEFAULT_CODEX_MODEL,
  type RunCommand,
} from "../../src/providers/brains/cli.ts"
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

const REPLY = JSON.stringify({ kind: "reply", text: "We have space." })

/** A fake CLI that records how it was called and answers on stdout. */
function cliSaying(stdout: string, code = 0) {
  const calls: Parameters<RunCommand>[0][] = []
  const run: RunCommand = async (call) => {
    calls.push(call)
    return { code, stdout, stderr: "" }
  }
  /** One flag's value, as the command line passed it. */
  const valueOf = (flag: string, at = 0): string | undefined => {
    const args = calls[at]?.args ?? []
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  const has = (flag: string, at = 0) => (calls[at]?.args ?? []).includes(flag)
  return { run, calls, valueOf, has }
}

describe("Spec 23: the Claude Code flags the check turned up", () => {
  test("BRAIN-1: -p, because the schema and the output format need it", async () => {
    const { run, has } = cliSaying(REPLY)
    await claudeCodeCliBrain({ apiKey: "sk-test", run }).complete(input)

    // --json-schema and --output-format are both documented as "only
    // works with --print".
    expect(has("-p")).toBe(true)
    expect(has("--output-format")).toBe(true)
  })

  test("Spec 23: --bare, which is what keeps the machine out of the answer", async () => {
    // It skips hooks, plugins, LSP, auto-memory, keychain reads and
    // CLAUDE.md auto-discovery. Without it the agent's replies would
    // depend on whose machine it ran on.
    const { run, has } = cliSaying(REPLY)
    await claudeCodeCliBrain({ apiKey: "sk-test", run }).complete(input)

    expect(has("--bare")).toBe(true)
  })

  test('Spec 23: --tools "" , which the CLI documents as disabling all tools', async () => {
    const { run, valueOf, has } = cliSaying(REPLY)
    await claudeCodeCliBrain({ apiKey: "sk-test", run }).complete(input)

    expect(has("--tools")).toBe(true)
    expect(valueOf("--tools")).toBe("")
  })

  test("BRAIN-2: the schema goes inline, not as a file", async () => {
    // Checked: --json-schema takes the JSON itself, unlike Codex.
    const { run, valueOf } = cliSaying(REPLY)
    await claudeCodeCliBrain({ apiKey: "sk-test", run }).complete(input)

    const schema = JSON.parse(valueOf("--json-schema") ?? "{}") as Record<string, unknown>
    const properties = schema["properties"] as Record<string, Record<string, unknown>>
    expect(properties["tool"]?.["enum"]).toEqual(["book_table"])
  })

  test("BRAIN-1: the system prompt is passed, and it carries the shape", async () => {
    const { run, valueOf } = cliSaying(REPLY)
    await claudeCodeCliBrain({ apiKey: "sk-test", run }).complete(input)

    const system = valueOf("--system-prompt") ?? ""
    expect(system.startsWith("You are the host.")).toBe(true)
    expect(system).toContain("# How to answer")
  })

  test("Spec 23: the prompt snapshot is off, so a changed prompt is not ignored", async () => {
    // With it on, the first prompt of a conversation is recorded and
    // reused verbatim even when a later call passes different text. Off
    // under --bare already, and said anyway in case that default moves.
    const { run, valueOf } = cliSaying(REPLY)
    await claudeCodeCliBrain({ apiKey: "sk-test", run }).complete(input)

    expect(valueOf("--system-prompt-snapshot")).toBe("off")
  })

  test("BRAIN-1: no session is kept, because every turn is its own", async () => {
    const { run, has } = cliSaying(REPLY)
    await claudeCodeCliBrain({ apiKey: "sk-test", run }).complete(input)

    expect(has("--no-session-persistence")).toBe(true)
  })

  test("Spec 23: the key goes in the environment, with the rest of it kept", async () => {
    // Under --bare this is the only way it can authenticate: OAuth and
    // the keychain are never read.
    const { run, calls } = cliSaying(REPLY)
    await claudeCodeCliBrain({ apiKey: "sk-secret", run }).complete(input)

    expect(calls[0]?.env["ANTHROPIC_API_KEY"]).toBe("sk-secret")
    expect(calls[0]?.env["PATH"] ?? calls[0]?.env["Path"]).toBeDefined()
  })

  test("LOOP-7: the conversation goes in on stdin", async () => {
    const { run, calls } = cliSaying(REPLY)
    await claudeCodeCliBrain({ apiKey: "sk-test", run }).complete({
      ...input,
      messages: [
        { role: "person", text: "any space friday?" },
        { role: "operator", text: "I can squeeze you in." },
      ],
    })

    expect(calls[0]?.stdin).toContain("Person: any space friday?")
    expect(calls[0]?.stdin).toContain("A human colleague")
  })

  test("BRAIN-1: the model comes from config, with a pinned fallback", async () => {
    const { run, valueOf } = cliSaying(REPLY)
    const brain = claudeCodeCliBrain({ apiKey: "sk-test", run })

    await brain.complete({ ...input, model: "sonnet" })
    expect(valueOf("--model", 0)).toBe("sonnet")

    await brain.complete(input)
    expect(valueOf("--model", 1)).toBe(DEFAULT_CLAUDE_CLI_MODEL)
  })
})

describe("BRAIN-1: reading what the CLI printed", () => {
  test("BRAIN-2: the answer inside the JSON envelope is found", async () => {
    const { run } = cliSaying(
      JSON.stringify({ type: "result", result: REPLY, session_id: "abc", total_cost_usd: 0.001 }),
    )
    const output = await claudeCodeCliBrain({ apiKey: "sk-test", run }).complete(input)

    expect(output.text).toBe("We have space.")
  })

  test("BRAIN-2: structured_output is preferred where the envelope has it", async () => {
    const { run } = cliSaying(
      JSON.stringify({ structured_output: { kind: "reply", text: "from the attachment" } }),
    )
    const output = await claudeCodeCliBrain({ apiKey: "sk-test", run }).complete(input)

    expect(output.text).toBe("from the attachment")
  })

  test("BRAIN-2: a bare answer with no envelope still works", async () => {
    // The envelope has changed shape before, so the raw output is the
    // last resort rather than a failure.
    const { run } = cliSaying(REPLY)
    const output = await claudeCodeCliBrain({ apiKey: "sk-test", run }).complete(input)

    expect(output.text).toBe("We have space.")
  })

  test("BRAIN-2: an envelope this code has never seen costs a retry, not the brain", async () => {
    const { run } = cliSaying(JSON.stringify({ something_new: { kind: "reply", text: "hello" } }))
    const output = await claudeCodeCliBrain({ apiKey: "sk-test", run }).complete(input)

    // The shared reader searches the raw text for an object, and finds it.
    expect(output.text).toBe("hello")
  })

  test("unwrap: it gives back the raw text when it cannot do better", () => {
    expect(unwrap("not json at all")).toBe("not json at all")
    expect(unwrap("42")).toBe("42")
    expect(unwrap(JSON.stringify({ unrelated: 1 }))).toBe(JSON.stringify({ unrelated: 1 }))
  })

  test("BRAIN-5: a non zero exit is a retryable error naming what it said", async () => {
    const run: RunCommand = async () => ({
      code: 1,
      stdout: "",
      stderr: "Invalid API key · Please run /login",
    })

    let thrown: unknown
    try {
      await claudeCodeCliBrain({ apiKey: "bad", run }).complete(input)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).retryable).toBe(true)
    expect((thrown as BrainError).message).toContain("Invalid API key")
  })

  test("BRAIN-1: it says it is a cli brain, which is what BRAIN-4 reads", async () => {
    const { run } = cliSaying(REPLY)
    const brain = claudeCodeCliBrain({ apiKey: "sk-test", run })

    expect(brain.id).toBe("claude-code-cli")
    expect(brain.kind).toBe("cli")
  })
})

describe("Spec 23: the Codex flags, which are a different shape", () => {
  /** A fake Codex that writes its answer to the file it was given. */
  function codexSaying(answer: string, code = 0) {
    const calls: Parameters<RunCommand>[0][] = []
    const schemas: string[] = []
    const run: RunCommand = async (call) => {
      calls.push(call)
      const args = call.args
      const schemaPath = args[args.indexOf("--output-schema") + 1]
      if (schemaPath !== undefined) schemas.push(await readFile(schemaPath, "utf8"))
      const answerPath = args[args.indexOf("-o") + 1]
      if (answerPath !== undefined && answer !== "") {
        await Bun.write(answerPath, answer)
      }
      return { code, stdout: "", stderr: "" }
    }
    const valueOf = (flag: string, at = 0): string | undefined => {
      const args = calls[at]?.args ?? []
      const index = args.indexOf(flag)
      return index === -1 ? undefined : args[index + 1]
    }
    const has = (flag: string, at = 0) => (calls[at]?.args ?? []).includes(flag)
    return { run, calls, schemas, valueOf, has }
  }

  test("BRAIN-1: exec, with the prompt read from stdin", async () => {
    const { run, calls, has } = codexSaying(REPLY)
    await codexCliBrain({ apiKey: "sk-test", run }).complete(input)

    expect(calls[0]?.args[0]).toBe("exec")
    expect(has("-")).toBe(true)
    expect(calls[0]?.stdin).toContain("Person: a table for four")
  })

  test("Spec 23: the schema goes to a file, not inline", async () => {
    const { run, schemas } = codexSaying(REPLY)
    await codexCliBrain({ apiKey: "sk-test", run }).complete(input)

    const schema = JSON.parse(schemas[0] ?? "{}") as Record<string, unknown>
    const properties = schema["properties"] as Record<string, Record<string, unknown>>
    expect(properties["tool"]?.["enum"]).toEqual(["book_table"])
  })

  test("Spec 23: the answer is read from the file it was told to write", async () => {
    const { run } = codexSaying(REPLY)
    const output = await codexCliBrain({ apiKey: "sk-test", run }).complete(input)

    expect(output.text).toBe("We have space.")
  })

  test("BRAIN-4: read only, because Codex cannot be told to have no tools", async () => {
    // There is no --tools "" here. The sandbox is the most that can be
    // done, and it still reads the filesystem, which is one reason
    // BRAIN-4 keeps this out of production.
    const { run, valueOf } = codexSaying(REPLY)
    await codexCliBrain({ apiKey: "sk-test", run }).complete(input)

    expect(valueOf("--sandbox")).toBe("read-only")
  })

  test("Spec 23: it ignores the machine's own Codex config", async () => {
    const { run, has } = codexSaying(REPLY)
    await codexCliBrain({ apiKey: "sk-test", run }).complete(input)

    expect(has("--ignore-user-config")).toBe(true)
    expect(has("--ephemeral")).toBe(true)
    expect(has("--skip-git-repo-check")).toBe(true)
  })

  test("BRAIN-1: Codex has no system prompt flag, so the system goes in front", async () => {
    const { run, calls } = codexSaying(REPLY)
    await codexCliBrain({ apiKey: "sk-test", run }).complete(input)

    expect(calls[0]?.stdin.startsWith("You are the host.")).toBe(true)
    expect(calls[0]?.stdin).toContain("# How to answer")
  })

  test("BRAIN-1: the model comes from config, with a pinned fallback", async () => {
    const { run, valueOf } = codexSaying(REPLY)
    const brain = codexCliBrain({ apiKey: "sk-test", run })

    await brain.complete({ ...input, model: "gpt-5" })
    expect(valueOf("-m", 0)).toBe("gpt-5")

    await brain.complete(input)
    expect(valueOf("-m", 1)).toBe(DEFAULT_CODEX_MODEL)
  })

  test("the temp files are cleaned up, however the call went", async () => {
    const { run, calls } = codexSaying(REPLY)
    await codexCliBrain({ apiKey: "sk-test", run }).complete(input)

    const schemaPath = calls[0]?.args[calls[0].args.indexOf("--output-schema") + 1] ?? ""
    expect(await Bun.file(schemaPath).exists()).toBe(false)
  })

  test("the temp files are cleaned up even when the call fails", async () => {
    const { run, calls } = codexSaying("", 1)

    try {
      await codexCliBrain({ apiKey: "sk-test", run }).complete(input)
    } catch {
      // Expected.
    }
    const schemaPath = calls[0]?.args[calls[0].args.indexOf("--output-schema") + 1] ?? ""
    expect(await Bun.file(schemaPath).exists()).toBe(false)
  })

  test("two calls at once do not read each other's answer", async () => {
    // Each call gets its own directory, so the answer file cannot be
    // shared. Tested because one shared path would mostly work and fail
    // under load, which is the worst way for it to fail.
    const paths: string[] = []
    const run: RunCommand = async (call) => {
      const answerPath = call.args[call.args.indexOf("-o") + 1] ?? ""
      paths.push(answerPath)
      await Bun.write(answerPath, JSON.stringify({ kind: "reply", text: call.stdin.slice(-6) }))
      return { code: 0, stdout: "", stderr: "" }
    }

    const brain = codexCliBrain({ apiKey: "sk-test", run })
    await Promise.all([
      brain.complete({ ...input, messages: [{ role: "person", text: "firstA" }] }),
      brain.complete({ ...input, messages: [{ role: "person", text: "secondB" }] }),
    ])

    expect(new Set(paths).size).toBe(2)
  })

  test("BRAIN-5: a non zero exit is a retryable error", async () => {
    const { run } = codexSaying("", 2)

    let thrown: unknown
    try {
      await codexCliBrain({ apiKey: "sk-test", run }).complete(input)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(BrainError)
    expect((thrown as BrainError).retryable).toBe(true)
  })

  test("BRAIN-1: it says it is a cli brain", async () => {
    const { run } = codexSaying(REPLY)
    expect(codexCliBrain({ apiKey: "sk-test", run }).kind).toBe("cli")
    expect(codexCliBrain({ apiKey: "sk-test", run }).id).toBe("codex-cli")
  })
})
