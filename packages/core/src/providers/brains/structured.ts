// BRAIN-2: the brains that have no native tool calling.
//
// OpenRouter gets a `tools` array and answers with a `tool_calls` entry.
// The Claude Agent SDK, the OpenAI Agents SDK and both CLI brains do not
// work that way: they are asked for one JSON object and they answer with
// text. So all four need the same three things, and they are here rather
// than four times over:
//
//   the shape to ask for, as a JSON schema and as words in the prompt,
//   a reader that turns the answer into a BrainOutput,
//   and one retry when the answer is not that shape.
//
// `structuredBrain` takes a function that produces text and returns a
// whole `Brain`. That is the point of the file: T5.2 to T5.4 each supply
// one call and inherit everything else, so a fix to the reader fixes four
// brains and a difference between them is a difference in one function.
import type { JSONSchema } from "../../tools/define.ts"
import {
  BrainError,
  type Brain,
  type BrainInput,
  type BrainMessage,
  type BrainOutput,
  type BrainTool,
  type BrainUsage,
} from "./types.ts"

/** BRAIN-2's shape, as the two values `kind` may take. */
export const REPLY = "reply"
export const TOOL = "tool"

/**
 * BRAIN-2's schema, with `tool` narrowed to what was offered.
 *
 * An enum rather than a free string, because then the provider refuses an
 * invented tool before it reaches us, and C8's first bar costs nothing. A
 * brain with no tools offered gets no `tool` property at all, which is
 * clearer than an empty enum that some validators reject.
 *
 * `args` is a free object on purpose. A schema per tool would have to be a
 * union, and structured output support for unions varies by provider
 * (Spec section 23). It is not needed either: LOOP-8 step 6 checks the
 * arguments against the tool's own zod schema one step later, and that
 * check has to happen whatever the brain is.
 */
export function structuredSchema(tools: BrainTool[]): JSONSchema {
  const names = tools.map((tool) => tool.name)

  const properties: Record<string, unknown> = {
    kind: { type: "string", enum: names.length === 0 ? [REPLY] : [REPLY, TOOL] },
    text: {
      type: "string",
      description: "What to say to the person. Required when kind is reply.",
    },
  }

  if (names.length > 0) {
    properties["tool"] = {
      type: "string",
      enum: names,
      description: "Which tool to call. Required when kind is tool.",
    }
    properties["args"] = {
      type: "object",
      description: "The arguments for that tool, matching its own schema.",
      additionalProperties: true,
    }
  }

  return {
    type: "object",
    properties,
    required: ["kind"],
    additionalProperties: false,
  }
}

/**
 * The words that go with the schema.
 *
 * Needed even where the schema is enforced. A provider that guarantees the
 * shape does not guarantee the brain understands what the fields mean, and
 * the tool descriptions have nowhere else to go when there is no `tools`
 * array to put them in.
 */
export function structuredInstructions(tools: BrainTool[]): string {
  const lines = [
    "# How to answer",
    "",
    "Answer with one JSON object and nothing else. No prose around it, no code fence.",
    "",
    'To say something to the person: {"kind":"reply","text":"..."}',
  ]

  if (tools.length === 0) {
    lines.push(
      "",
      "You have no tools on this step, so reply is the only answer there is.",
      "If you need something you cannot get, say so to the person.",
    )
    return lines.join("\n")
  }

  lines.push(
    'To use a tool: {"kind":"tool","tool":"<name>","args":{...}}',
    "",
    "One tool at a time. You will be given the result and can then use another.",
    "Use a tool only from the list below, spelled exactly as it appears.",
    "",
    "# Your tools",
  )

  for (const tool of tools) {
    lines.push("", `## ${tool.name}`, tool.description, "", "Arguments, as JSON Schema:")
    lines.push(JSON.stringify(tool.inputSchema))
  }

  return lines.join("\n")
}

/**
 * LOOP-7's messages as a plain transcript.
 *
 * For a brain that takes one prompt rather than a list, which is both CLI
 * brains. The labels are the roles LOOP-7 names, so an operator's words
 * and a notice are not passed off as the agent's own.
 */
export function toTranscript(messages: BrainMessage[]): string {
  const lines: string[] = []

  for (const message of messages) {
    switch (message.role) {
      case "person":
        lines.push(`Person: ${message.text}`)
        break
      case "agent":
        lines.push(`You: ${message.text}`)
        break
      case "operator":
        lines.push(`A human colleague, to the person: ${message.text}`)
        break
      case "notice":
        lines.push(`Shown to the person by the system: ${message.text}`)
        break
      case "tool_call":
        lines.push(`You called ${message.name} with ${JSON.stringify(message.input ?? {})}`)
        break
      case "tool_result":
        lines.push(
          message.error !== undefined
            ? `${message.name} failed: ${message.error}`
            : `${message.name} returned ${JSON.stringify(message.result)}`,
        )
        break
    }
  }

  return lines.join("\n")
}

/** What the reader found, or what was wrong with it. */
export type Read = { ok: true; output: BrainOutput } | { ok: false; problem: string; found: string }

/**
 * Pulls the JSON object out of whatever the model actually sent.
 *
 * Models fence JSON, apologise before it and explain after it, however
 * firmly they are told not to. Refusing those would mean falling back to
 * another brain over formatting, so the text is searched for the outermost
 * balanced object and that is parsed.
 */
export function extractObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced?.[1] ?? text

  const start = body.indexOf("{")
  if (start === -1) return null

  // Balanced, so an object with a nested object survives, and a string
  // containing a brace does not end it early.
  let depth = 0
  let inString = false
  let escaped = false

  for (let at = start; at < body.length; at++) {
    const char = body[at]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return body.slice(start, at + 1)
    }
  }
  return null
}

/** The short version of what came back, for an error a builder can read. */
const shorten = (text: string): string =>
  text.length <= 300 ? text : `${text.slice(0, 300)}... (${text.length} characters)`

/** BRAIN-2: the answer, as a `BrainOutput` or as what was wrong with it. */
export function readStructured(text: string, tools: BrainTool[]): Read {
  const found = shorten(text.trim())
  const json = extractObject(text)
  if (json === null) {
    return { ok: false, problem: "there was no JSON object in the answer", found }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return {
      ok: false,
      problem: `the JSON did not parse: ${error instanceof Error ? error.message : "unknown"}`,
      found,
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, problem: "the answer was not a JSON object", found }
  }
  const answer = parsed as Record<string, unknown>
  const kind = answer["kind"]

  if (kind === REPLY) {
    const reply = typeof answer["text"] === "string" ? answer["text"].trim() : ""
    if (reply === "") {
      return { ok: false, problem: 'kind was "reply" but text was empty', found }
    }
    return { ok: true, output: { text: reply, finishReason: "stop", usage: NO_USAGE } }
  }

  if (kind === TOOL) {
    const name = answer["tool"]
    if (typeof name !== "string" || name === "") {
      return { ok: false, problem: 'kind was "tool" but no tool was named', found }
    }

    // BRAIN-2 says one of the offered names. A name that was not offered
    // is a shape failure rather than an unknown tool: LOOP-8 step 5 exists
    // for a brain that calls what it was not shown, and this brain was
    // handed an enum, so getting it wrong says the shape was not followed.
    if (!tools.some((tool) => tool.name === name)) {
      const offered = tools.map((tool) => tool.name).join(", ")
      return {
        ok: false,
        problem: `${name} is not one of the tools offered (${offered === "" ? "none" : offered})`,
        found,
      }
    }

    const args = answer["args"]
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return { ok: false, problem: "args was not an object", found }
    }

    return {
      ok: true,
      output: {
        toolCalls: [{ id: `${name}-1`, name, input: args ?? {} }],
        finishReason: "tool_calls",
        usage: NO_USAGE,
      },
    }
  }

  return {
    ok: false,
    problem: `kind was ${JSON.stringify(kind)}, and it has to be "${REPLY}" or "${TOOL}"`,
    found,
  }
}

const NO_USAGE: BrainUsage = { inputTokens: 0, outputTokens: 0 }

/** What a structured brain is asked for. */
export interface StructuredRequest {
  model: string
  /** The agent's system prompt, then the shape and the tool list. */
  system: string
  messages: BrainMessage[]
  /** The same messages as one transcript, for a brain that takes one. */
  transcript: string
  /** BRAIN-2's shape, to enforce where the provider can. */
  schema: JSONSchema
  tools: BrainTool[]
  signal?: AbortSignal | undefined
  /**
   * What was wrong with the last answer, on a retry.
   *
   * Passed rather than folded into `system` so a provider that caches the
   * system prompt keeps the cache, and so a brain that has a better place
   * to put a correction can use it.
   */
  correction?: string | undefined
}

export interface StructuredAnswer {
  /** The model's answer, as text. The reader does the rest. */
  text: string
  usage?: BrainUsage | undefined
}

export interface StructuredOptions {
  id: string
  kind: "api" | "cli"
  supportsImages?: boolean | undefined
  /** The one function each brain supplies. */
  ask: (request: StructuredRequest) => Promise<StructuredAnswer>
  /**
   * How many more times to ask when the shape is wrong. One by default.
   *
   * BRAIN-5 moves to the next brain after the shape fails twice in a row,
   * so one retry here is what makes that "twice" rather than "once".
   */
  retries?: number | undefined
}

/** BRAIN-2: a brain with no native tool calling, as a `Brain`. */
export function structuredBrain(options: StructuredOptions): Brain {
  const retries = options.retries ?? 1

  return {
    id: options.id,
    kind: options.kind,
    supportsImages: options.supportsImages ?? false,

    async complete(input: BrainInput): Promise<BrainOutput> {
      const schema = structuredSchema(input.tools)
      const system = `${input.system}\n\n---\n\n${structuredInstructions(input.tools)}`
      const transcript = toTranscript(input.messages)

      let correction: string | undefined
      let usage: BrainUsage = NO_USAGE
      let last: Extract<Read, { ok: false }> | undefined

      for (let attempt = 0; attempt <= retries; attempt++) {
        const answer = await options.ask({
          model: input.model,
          system,
          messages: input.messages,
          transcript,
          schema,
          tools: input.tools,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          ...(correction !== undefined ? { correction } : {}),
        })

        // Both attempts are paid for, so both are counted. A turn that
        // reported only the successful call would understate what it cost.
        usage = {
          inputTokens: usage.inputTokens + (answer.usage?.inputTokens ?? 0),
          outputTokens: usage.outputTokens + (answer.usage?.outputTokens ?? 0),
          ...(answer.usage?.costUsd !== undefined || usage.costUsd !== undefined
            ? { costUsd: (usage.costUsd ?? 0) + (answer.usage?.costUsd ?? 0) }
            : {}),
        }

        const read = readStructured(answer.text, input.tools)
        if (read.ok) return { ...read.output, usage }

        last = read
        correction = [
          `Your last answer could not be used: ${read.problem}.`,
          "Answer with one JSON object and nothing else.",
        ].join(" ")
      }

      // BRAIN-5: the shape failed every time it was asked, so this brain
      // cannot answer this step. Retryable, because the next attempt is a
      // different sample from the same model and may well parse.
      throw new BrainError(
        options.id,
        `did not answer in the required shape after ${retries + 1} attempts: ${
          last?.problem ?? "unknown"
        }. It sent: ${last?.found ?? ""}`,
        true,
      )
    },
  }
}
