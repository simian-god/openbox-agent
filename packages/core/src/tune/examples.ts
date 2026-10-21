// LEARN-5: the labeled examples `openbox tune` measures a threshold against.
//
// They come from two places, and the order matters.
//
// Every tool already carries example messages, because TOOL-2 refuses to
// register one without them. So an agent has labeled routing data on the
// day it is written, before it has answered a single real message, and
// `tune` is useful immediately rather than after weeks of traffic.
//
// `examples/routing.jsonl` is the set that grows. LEARN-5 appends a line
// every time the builder reviews a routing decision, so it holds real
// messages with the tool that should have been chosen. Those are better
// evidence than a tool's own examples, which were written by whoever
// imagined the conversation, so they win on a tie.
import { NO_TOOL } from "../runtime/routing.ts"
import type { Role, Tool } from "../tools/index.ts"

/** One labeled message, or conversation, and what should have happened. */
export interface LabeledExample {
  /** For the report, so a bad number can be traced to its source. */
  source: "tools" | "jsonl"
  /** Where it came from exactly: a tool name, or a file and line. */
  where: string
  /** The conversation before the batch, oldest first (ROUTE-1). */
  messages: { role: string; text: string }[]
  /** What the person has just said. */
  batch: string[]
  /** The tool that should be chosen, or `no_tool`. */
  tool?: string | undefined
  /**
   * A tool that must not be chosen, from its own `shouldNot` examples.
   *
   * A negative says less than a positive: it rules one tool out and names
   * no replacement, so it cannot say whether the right tool was shown. It
   * is measured on its own instead, because calling a write tool one
   * message too early is the most common real routing fault and this is
   * the only labeled evidence of it an agent has for free.
   */
  notTool?: string | undefined
  role: Role
}

export const ROUTING_EXAMPLES_FILE = "examples/routing.jsonl"

/** True when this example says which tool is right. */
export const isPositive = (example: LabeledExample): boolean => example.tool !== undefined

/** The conversation alone, as one comparable key. */
export function conversationKey(example: LabeledExample): string {
  return JSON.stringify([
    example.role,
    example.messages.map((message) => [message.role, message.text.trim().toLowerCase()]),
    example.batch.map((text) => text.trim().toLowerCase()),
  ])
}

/**
 * What makes two examples the same label, which is not the same question.
 *
 * A conversation has one right tool, so two positives for one conversation
 * disagree and only one of them can stand. A negative says one tool must
 * not be chosen and names no replacement, so several of them can be true
 * of the same conversation at once. Six tools that all list "hello" under
 * `shouldNot` are making six different statements, and folding them into
 * one would quietly stop checking five of them.
 */
function labelKey(example: LabeledExample): string {
  return example.tool !== undefined
    ? `+${conversationKey(example)}`
    : `-${example.notTool ?? ""}${conversationKey(example)}`
}

/**
 * TOOL-1's own examples, as labeled routing data.
 *
 * A tool allowed for both roles is labeled under the first one it lists.
 * Routing asks a separate question per role, and an example cannot be in
 * two of them at once without being counted twice.
 */
export function examplesFromTools(tools: Tool[]): LabeledExample[] {
  const found: LabeledExample[] = []

  for (const tool of tools) {
    const role = tool.roles[0] ?? "end_user"
    for (const text of tool.examples.should) {
      found.push({
        source: "tools",
        where: `${tool.name}.examples.should`,
        messages: [],
        batch: [text],
        tool: tool.name,
        role,
      })
    }
    for (const text of tool.examples.shouldNot) {
      found.push({
        source: "tools",
        where: `${tool.name}.examples.shouldNot`,
        messages: [],
        batch: [text],
        notTool: tool.name,
        role,
      })
    }
  }

  return found
}

export interface ParsedExamples {
  examples: LabeledExample[]
  /** Every problem in the file, with its line, reported in one pass. */
  problems: string[]
}

const ROLES = new Set(["end_user", "operator"])

/**
 * Reads `examples/routing.jsonl`.
 *
 * Two shapes per line. `{ "text": "...", "tool": "..." }` for a message
 * that stands alone, which is what a builder writes by hand. Or
 * `{ "messages": [...], "batch": [...], "tool": "..." }` when the right
 * tool depends on what came before, which is the case routing most often
 * gets wrong and the one a single message cannot express.
 *
 * Every problem in the file is collected rather than thrown at the first
 * one, the same way a tool and a config report theirs, because fixing a
 * labeled set one line per run is miserable.
 */
export function parseRoutingJsonl(
  text: string,
  path: string,
  knownTools: string[],
): ParsedExamples {
  const examples: LabeledExample[] = []
  const problems: string[] = []
  const known = new Set([...knownTools, NO_TOOL])

  text.split("\n").forEach((raw, index) => {
    const line = raw.trim()
    if (line === "" || line.startsWith("//")) return
    const at = `${path}:${index + 1}`

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      problems.push(`${at}: not valid JSON (${error instanceof Error ? error.message : "?"})`)
      return
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      problems.push(`${at}: each line must be a JSON object`)
      return
    }
    const row = parsed as Record<string, unknown>

    // The batch: either `text` for one message, or `batch` for several.
    let batch: string[] | undefined
    if (typeof row["text"] === "string") {
      batch = [row["text"]]
    } else if (Array.isArray(row["batch"])) {
      const lines = row["batch"]
      if (lines.length === 0 || !lines.every((entry) => typeof entry === "string")) {
        problems.push(`${at}: batch must be a non empty list of strings`)
        return
      }
      batch = lines as string[]
    }
    if (batch === undefined) {
      problems.push(`${at}: needs "text" with the message, or "batch" with several`)
      return
    }

    const messages: { role: string; text: string }[] = []
    if (row["messages"] !== undefined) {
      if (!Array.isArray(row["messages"])) {
        problems.push(`${at}: messages must be a list of { role, text }`)
        return
      }
      for (const entry of row["messages"]) {
        const message = entry as Record<string, unknown>
        if (typeof message?.["role"] !== "string" || typeof message?.["text"] !== "string") {
          problems.push(`${at}: every message needs a role and a text`)
          return
        }
        messages.push({ role: message["role"], text: message["text"] })
      }
    }

    const tool = row["tool"]
    if (typeof tool !== "string" || tool === "") {
      problems.push(`${at}: needs "tool" with the tool that should be chosen, or "${NO_TOOL}"`)
      return
    }
    // A label for a tool that does not exist is an example proving
    // nothing: it can never be chosen, so it can only ever count as a
    // miss. Much better found here than read as a bad accuracy number.
    if (!known.has(tool)) {
      problems.push(
        `${at}: "${tool}" is not a tool this agent has. Its tools are: ${knownTools.join(", ")}`,
      )
      return
    }

    const role = row["role"]
    if (role !== undefined && (typeof role !== "string" || !ROLES.has(role))) {
      problems.push(`${at}: role must be end_user or operator`)
      return
    }

    examples.push({
      source: "jsonl",
      where: at,
      messages,
      batch,
      tool,
      role: (role as Role | undefined) ?? "end_user",
    })
  })

  return { examples, problems }
}

/**
 * The two sets as one, with duplicates dropped.
 *
 * A reviewed line wins over a tool's own example for the same
 * conversation: it is what really happened, and it was labeled by someone
 * looking at the consequence rather than imagining it.
 */
export function mergeExamples(
  fromTools: LabeledExample[],
  fromFile: LabeledExample[],
): LabeledExample[] {
  const byLabel = new Map<string, LabeledExample>()
  for (const example of fromTools) byLabel.set(labelKey(example), example)
  for (const example of fromFile) byLabel.set(labelKey(example), example)
  return [...byLabel.values()]
}
