// BRAIN-1: the Claude Agent SDK, as a brain.
//
// Checked against the installed package before any of this was written
// (Spec section 23), and four of its defaults turned out to matter.
//
// Two more things turned up when it was first run against the real SDK
// rather than an injected `query`, and both of them stopped it answering
// anybody at all. Reading the package was not enough to find either, and
// neither was a suite that passed: see DEFAULT_MAX_TURNS for the turn
// count a json_schema run really needs, and the catch in `ask` for the
// fact that an error result arrives as a throw and not as a message. The
// lesson for the next adapter is in the shape of the fake: a stream that
// only ever yields cannot tell a clean end from an exception, so every
// error path here was tested against something the SDK never does.
//
// It is an optional peer dependency, not a dependency, because the package
// ships a platform binary of about 289 MB. The import below is lazy and
// the error names the install command, so an agent on another brain pays
// neither the download nor the load.
//
// It spawns a subprocess. The SDK ships its own Claude Code executable and
// starts one per call, so this is an `api` brain by BRAIN-1's table and a
// process by behaviour. That is the Plan's own risk row about latency, now
// confirmed rather than suspected, and it is why OpenRouter stays the
// default production brain.
//
// `settingSources` loads everything by default: the developer's
// `~/.claude/settings.json`, the project's `.claude/settings.json`, its
// `.local` variant, and CLAUDE.md. For a brain that is not a default, it
// is a bug: a restaurant agent's answers would be shaped by whatever is in
// the builder's own Claude settings, and on a server by whatever happens
// to be on that disk. `[]` is the SDK's isolation mode and is passed
// always.
//
// `allowedTools` is used rather than `disallowedTools`, because the SDK's
// own type docs say the list of built in tool names "is not complete: the
// CLI has tools that are not on it, so it cannot stand for every tool".
// A deny list of names cannot be trusted to deny everything. An allow list
// of nothing can.
//
// `env` REPLACES the subprocess environment when it is set rather than
// merging, so passing a key alone would take `PATH` away from the process
// and it would fail to start. `process.env` is spread in deliberately.
import { BrainError, type Brain, type BrainUsage } from "./types.ts"
import { structuredBrain, type StructuredAnswer, type StructuredRequest } from "./structured.ts"

/** Pinned, so a new default model cannot arrive under a running agent. */
export const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5"

/**
 * How many round trips one call may take. Measured, not read off the docs.
 *
 * The SDK's own types say a turn is "a user message and assistant
 * response", so this was 1, and every single call failed as
 * `error_max_turns`. With `outputFormat: json_schema` a run is two round
 * trips: the model answers, and a second turn turns that into the
 * structured output. The first live run of this brain is what found it.
 *
 * 4 rather than 2, because the SDK retries the shape itself before giving
 * up, and a run that hits the ceiling mid retry reports a turn limit
 * instead of the shape failure it really was, which is the one error
 * BRAIN-5 handles specially. The headroom cannot become an agentic loop:
 * `allowedTools` is empty, so there are no tools to loop on, and the core
 * runs its own step loop (LOOP-8).
 */
export const DEFAULT_MAX_TURNS = 4

/**
 * Result subtypes that another attempt cannot help.
 *
 * A limit reached is not an outage: the same request meets the same limit,
 * so retrying only spends it twice. BRAIN-5 still moves to the next brain,
 * which is a different thing from this brain retrying itself.
 */
const SPENT_NOT_BROKEN = new Set(["error_max_turns", "error_max_budget_usd"])

/** What this brain needs from the SDK, as the one function it calls. */
export type SdkQuery = (params: {
  prompt: string
  options?: Record<string, unknown>
}) => AsyncIterable<unknown>

export interface ClaudeAgentSdkOptions {
  apiKey: string
  model?: string | undefined
  /**
   * Which JS runtime the subprocess uses. Bun by default.
   *
   * The core only runs on Bun, which is a constraint rather than a
   * preference, so Bun is the one runtime guaranteed to be on the machine
   * and node is not. Letting the SDK pick would mean a brain that works
   * in development and cannot start on a server that has only Bun.
   */
  executable?: "bun" | "deno" | "node" | undefined
  /** An executable of your own, for a pinned install. */
  pathToClaudeCodeExecutable?: string | undefined
  /**
   * How many round trips one call may take. `DEFAULT_MAX_TURNS` otherwise.
   *
   * Raise it only for a model that needs longer to produce the shape.
   * This is a cap on one step of the core's own loop, not a budget for
   * the SDK to do a loop of its own.
   */
  maxTurns?: number | undefined
  /** Used as given, so a test needs no SDK and no network (TEST-3, DEP-1). */
  query?: SdkQuery | undefined
}

/** The result message, as the parts this brain reads from it. */
interface SdkResult {
  type: "result"
  subtype?: string
  is_error?: boolean
  structured_output?: unknown
  total_cost_usd?: number
  usage?: { input_tokens?: number; output_tokens?: number }
}

const isResult = (message: unknown): message is SdkResult =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "result"

/**
 * The SDK's own retry for structured output, and what it says when it
 * gives up.
 *
 * Worth naming rather than lumping in with every other error: it means the
 * model could not produce the shape, which is BRAIN-5's own case, and it
 * is retryable because the next attempt is a different sample.
 */
const SHAPE_FAILED = "error_max_structured_output_retries"

export function claudeAgentSdkBrain(options: ClaudeAgentSdkOptions): Brain {
  const model = options.model ?? DEFAULT_CLAUDE_MODEL

  // Loaded on first use rather than at import. The SDK pulls in a hundred
  // packages and ships an executable, and an agent on another brain should
  // not pay for either.
  let query: SdkQuery | undefined = options.query
  async function sdkQuery(): Promise<SdkQuery> {
    if (query !== undefined) return query
    try {
      const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
        query: SdkQuery
      }
      query = sdk.query
      return query
    } catch (error) {
      // An optional peer dependency, so this is the expected state for an
      // agent that has not asked for this brain. The message is the whole
      // value of that choice: the package is ~289 MB with its platform
      // binary, and nobody should download it to run on OpenRouter.
      throw new BrainError(
        "claude-agent-sdk",
        [
          "the claude-agent-sdk brain needs a package that is not installed.",
          "Run: bun add @anthropic-ai/claude-agent-sdk",
          "It is an optional peer dependency because it ships a platform binary of",
          "about 289 MB, so only an agent that names this brain pays for it.",
          `The loader said: ${error instanceof Error ? error.message : String(error)}`,
        ].join(" "),
        false,
      )
    }
  }

  async function ask(request: StructuredRequest): Promise<StructuredAnswer> {
    const run = await sdkQuery()

    const prompt =
      request.correction === undefined
        ? request.transcript
        : `${request.transcript}\n\n${request.correction}`

    const stream = run({
      prompt,
      options: {
        // A plain string is a custom prompt: the SDK's own preset does not
        // apply, which is what BRAIN-1 asks for.
        systemPrompt: request.system,
        model: request.model === "" ? model : request.model,
        // Two round trips minimum with a json_schema output. See
        // DEFAULT_MAX_TURNS, which exists because this was 1.
        maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
        // An allow list of nothing. See the note at the top of this file.
        allowedTools: [],
        // The SDK's isolation mode. Nothing on the machine shapes the answer.
        settingSources: [],
        outputFormat: { type: "json_schema", schema: request.schema },
        // Replaces rather than merges, so the rest of the environment has
        // to be spread in or the subprocess loses PATH.
        env: { ...process.env, ANTHROPIC_API_KEY: options.apiKey },
        executable: options.executable ?? "bun",
        ...(options.pathToClaudeCodeExecutable !== undefined
          ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }
          : {}),
        ...(request.signal !== undefined ? { abortController: toController(request.signal) } : {}),
      },
    })

    let result: SdkResult | undefined
    let failure: unknown
    try {
      for await (const message of stream) {
        // Only the result matters. The assistant messages in between are the
        // SDK's own turn, and with json_schema the answer is an attachment on
        // the result rather than the last assistant message.
        if (isResult(message)) result = message
      }
    } catch (error) {
      // The SDK does not end the stream on an error result, it throws. Its
      // `readMessages` catches the subprocess exiting and rethrows as
      // "Claude Code returned an error result: ...", having already sent
      // the result itself down the stream. So the result is the better
      // account of what happened and the throw is only news when there is
      // no result, which is a subprocess that never got going.
      //
      // Everything below used to be unreachable because of this, including
      // BRAIN-5's shape retry. The first live run of this brain is what
      // found it: a fake stream that only yields cannot tell the two
      // apart, so the tests passed and the brain answered nobody.
      failure = error
    }

    if (result === undefined) {
      const said = failure instanceof Error ? failure.message : String(failure ?? "")
      throw new BrainError(
        "claude-agent-sdk",
        said === "" ? "the session ended without a result" : said,
        true,
      )
    }

    const usage: BrainUsage = {
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
      ...(result.total_cost_usd !== undefined ? { costUsd: result.total_cost_usd } : {}),
    }

    if (result.subtype === SHAPE_FAILED) {
      // The SDK retried the shape itself and gave up. Reported as text that
      // cannot be read, so the shared adapter's own retry and BRAIN-5 take
      // it from here rather than this brain inventing a second policy.
      return { text: "", usage }
    }

    if (result.is_error === true || result.structured_output === undefined) {
      const subtype = result.subtype ?? "an error"
      throw new BrainError(
        "claude-agent-sdk",
        `the session ended as ${subtype} with no structured output`,
        !SPENT_NOT_BROKEN.has(subtype),
      )
    }

    // Already an object, and stringified so the shared reader validates it
    // on exactly the same rules as every other brain. One reader means a
    // tool that was never offered is caught the same way everywhere.
    return { text: JSON.stringify(result.structured_output), usage }
  }

  return structuredBrain({
    id: "claude-agent-sdk",
    kind: "api",
    supportsImages: true,
    ask,
  })
}

/** The SDK takes a controller, and the core has a signal. */
function toController(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  return controller
}
