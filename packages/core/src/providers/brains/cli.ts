// BRAIN-1 and BRAIN-4: the two CLI brains.
//
// These drive a command on the machine the agent is running on, which is
// why BRAIN-4 refuses them in production. They are for building an agent
// and poking at it, not for answering a real person.
//
// Both were checked against the installed commands before this was
// written (Spec section 23), and three things came out of it.
//
// `--bare` does more than the Spec claimed: it skips hooks, plugins, LSP,
// attribution, auto-memory, keychain reads and CLAUDE.md auto-discovery.
// That is exactly the isolation a brain needs. It also says "Anthropic
// auth is strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain
// are never read)", so a CLI brain needs a key and does not run on a
// logged-in subscription. Passed always, at the builder's decision: what
// you test is then what you ship.
//
// Claude takes its schema inline and prints its answer. Codex takes a
// schema file and writes its answer to a file, so that brain needs two
// temp files per call and has to clean them up.
//
// And Codex has no way to turn its tools off. `--sandbox read-only` stops
// it writing, and it can still read the filesystem. One more reason
// BRAIN-4 exists.
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrainError, type Brain } from "./types.ts"
import { structuredBrain, type StructuredAnswer, type StructuredRequest } from "./structured.ts"

/** Pinned, so a new default model cannot arrive under a running agent. */
export const DEFAULT_CLAUDE_CLI_MODEL = "haiku"
export const DEFAULT_CODEX_MODEL = "gpt-5-codex"

/** How long a CLI gets before it is given up on. */
export const DEFAULT_CLI_TIMEOUT_MS = 120_000

/** What running a command looks like, so a test needs no CLI (TEST-3). */
export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export type RunCommand = (input: {
  command: string
  args: string[]
  /** Written to the process's stdin, then closed. */
  stdin: string
  env: Record<string, string | undefined>
  timeoutMs: number
  signal?: AbortSignal | undefined
}) => Promise<RunResult>

/**
 * Spawns a command, writes the prompt to its stdin and collects its output.
 *
 * `shell: false`, so nothing in a prompt or a schema can be read as shell
 * syntax. The arguments go to the process as an array and never through a
 * command line a shell would parse.
 */
export const runCommand: RunCommand = async (input) => {
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      env: input.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`no answer within ${input.timeoutMs} ms`))
    }, input.timeoutMs)

    const stop = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(new Error("the call was abandoned"))
    }
    input.signal?.addEventListener("abort", stop, { once: true })

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })

    child.stdin?.end(input.stdin)
  })
}

export interface CliBrainOptions {
  /** CONF-2's note does not apply: this is the model's own key. */
  apiKey: string
  model?: string | undefined
  /** The command to run. For a pinned install, or a test. */
  command?: string | undefined
  timeoutMs?: number | undefined
  /** Used as given, so a test needs no CLI and no network (TEST-3, DEP-1). */
  run?: RunCommand | undefined
}

/** What a CLI said when it failed, short enough to read in an error. */
const said = (result: RunResult): string => {
  const text = `${result.stderr}\n${result.stdout}`.trim()
  return text.length <= 400 ? text : `${text.slice(0, 400)}...`
}

/** BRAIN-1: the Claude Code CLI, as a brain. */
export function claudeCodeCliBrain(options: CliBrainOptions = { apiKey: "" }): Brain {
  const command = options.command ?? "claude"
  const run = options.run ?? runCommand
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS

  async function ask(request: StructuredRequest): Promise<StructuredAnswer> {
    const prompt =
      request.correction === undefined
        ? request.transcript
        : `${request.transcript}\n\n${request.correction}`

    const result = await run({
      command,
      args: [
        "-p",
        // Checked, and it does more than the Spec said: no hooks, no
        // plugins, no LSP, no auto-memory, no CLAUDE.md discovery.
        "--bare",
        // Documented as "use "" to disable all tools". An explicit switch
        // rather than the SDK's empty allow list.
        "--tools",
        "",
        "--system-prompt",
        request.system,
        // Inline JSON, not a file. Only works with -p.
        "--json-schema",
        JSON.stringify(request.schema),
        "--output-format",
        "json",
        "--no-session-persistence",
        // Off under --bare already, and said anyway: with it on, the first
        // prompt of a conversation is recorded and reused verbatim even
        // when a later call passes different text.
        "--system-prompt-snapshot",
        "off",
        "--model",
        request.model === "" ? (options.model ?? DEFAULT_CLAUDE_CLI_MODEL) : request.model,
      ],
      stdin: prompt,
      // Under --bare this is the only way it can authenticate.
      env: { ...process.env, ANTHROPIC_API_KEY: options.apiKey },
      timeoutMs,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    })

    if (result.code !== 0) {
      throw new BrainError("claude-code-cli", `exited ${result.code}: ${said(result)}`, true)
    }

    // `--output-format json` wraps the answer. The shape has changed
    // before, so several field names are tried and the raw output is the
    // last resort: the shared reader can find an object in any of them.
    return { text: unwrap(result.stdout) }
  }

  return structuredBrain({ id: "claude-code-cli", kind: "cli", ask })
}

/**
 * Pulls the model's own answer out of a CLI's JSON envelope.
 *
 * It looks for BRAIN-2's own shape rather than for a field name, which is
 * both safer and more robust. Safer because the envelope's field names
 * collide with the answer's: a bare `{"kind":"reply","text":"..."}` has a
 * `text` field, and a reader that trusted field names returned the reply
 * text as though it were the whole answer, which then failed to parse.
 * More robust because an envelope that gets renamed in a later release
 * still works: what is being searched for is known exactly.
 *
 * Falls back to a named field holding the answer as a string, then to the
 * raw text, which the shared reader will search anyway.
 */
export function unwrap(stdout: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return stdout
  }

  const answer = findAnswer(parsed)
  if (answer !== null) return JSON.stringify(answer)

  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const envelope = parsed as Record<string, unknown>
    for (const field of ["structured_output", "structuredOutput", "result", "text", "response"]) {
      const value = envelope[field]
      if (typeof value === "string" && value.trim() !== "") return value
    }
  }
  return stdout
}

/**
 * The first object anywhere in here that is shaped like an answer.
 *
 * Depth limited, so a large envelope cannot be walked for ever.
 */
function findAnswer(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 5 || value === null || typeof value !== "object") return null

  if (!Array.isArray(value)) {
    const kind = (value as Record<string, unknown>)["kind"]
    if (kind === "reply" || kind === "tool") return value as Record<string, unknown>
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findAnswer(child, depth + 1)
    if (found !== null) return found
  }
  return null
}

/** BRAIN-1: the Codex CLI, as a brain. */
export function codexCliBrain(options: CliBrainOptions = { apiKey: "" }): Brain {
  const command = options.command ?? "codex"
  const run = options.run ?? runCommand
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS

  async function ask(request: StructuredRequest): Promise<StructuredAnswer> {
    const prompt =
      request.correction === undefined
        ? request.transcript
        : `${request.transcript}\n\n${request.correction}`

    // Codex takes its schema as a file and writes its answer to a file, so
    // this brain owns two temp files per call. In its own directory, so
    // two calls at once cannot read each other's answer.
    const dir = await mkdtemp(join(tmpdir(), "openbox-codex-"))
    const schemaPath = join(dir, "schema.json")
    const answerPath = join(dir, "answer.txt")

    try {
      await writeFile(schemaPath, JSON.stringify(request.schema), "utf8")

      const result = await run({
        command,
        args: [
          "exec",
          // The prompt comes from stdin.
          "-",
          "--output-schema",
          schemaPath,
          "-o",
          answerPath,
          // It cannot be told to have no tools, so this is the most that
          // can be done: it reads, it does not write.
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "--ephemeral",
          "--ignore-user-config",
          "-m",
          request.model === "" ? (options.model ?? DEFAULT_CODEX_MODEL) : request.model,
        ],
        // Codex has no system prompt flag, so the system goes in front of
        // the conversation. The shape instructions are in there too, which
        // is what matters most.
        stdin: `${request.system}\n\n---\n\n${prompt}`,
        env: { ...process.env, OPENAI_API_KEY: options.apiKey },
        timeoutMs,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      })

      if (result.code !== 0) {
        throw new BrainError("codex-cli", `exited ${result.code}: ${said(result)}`, true)
      }

      const answer = await readFile(answerPath, "utf8").catch(() => "")
      // Falls back to stdout: the answer file is the documented place, and
      // an empty one with a zero exit is still worth a look before giving
      // up on the call.
      return { text: answer.trim() === "" ? result.stdout : answer }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return structuredBrain({ id: "codex-cli", kind: "cli", ask })
}
