// LEARN-4 and LEARN-5: `openbox review`, which hands the skill the flags
// and the conversations behind them.
//
// The judgment is the skill's: deciding what actually went wrong, writing
// the fix as a diff, writing the failure as an evals-agent case, getting
// the builder's approval. This command is the part that has to be exact.
// Four subcommands, each one step of LEARN-4:
//
//   list    the unreviewed backlog, grouped by likely cause (steps 1, 2)
//   show    one flagged conversation, in full (step 1)
//   mark    a flag reviewed, with what came of it (step 7)
//   label   a corrected routing decision, appended (LEARN-5)
//
// `--json` is on `list` and `show` because the reader is usually an agent,
// and an agent re-reading its own prose is how a detail gets lost.
//
// Nothing here changes the agent. `label` writes to `examples/routing.jsonl`,
// which is evidence rather than behaviour: it changes what `openbox tune`
// measures, and tune still reports rather than writes unless asked
// (LEARN-7).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { createStore, type Store } from "../store/index.ts"
import { ProviderError, supabaseFromEnv, type Env } from "../providers/index.ts"
import {
  flaggedConversation,
  markReviewed,
  reviewBacklog,
  type CauseGroup,
  type FlaggedConversation,
} from "../review/index.ts"
import {
  appendRoutingExample,
  parseRoutingJsonl,
  ROUTING_EXAMPLES_FILE,
  withRoutingLine,
  type RoutingLabel,
} from "../tune/examples.ts"
import { loadProject, ProjectError, type LoadProjectOptions } from "./project.ts"
import { stdio, type ChatIo } from "./terminal.ts"

export interface ReviewOptions extends LoadProjectOptions {
  /** `list` (the default), `show`, `mark` or `label`, then its arguments. */
  args?: string[] | undefined
  env?: Env | undefined
  io?: ChatIo | undefined
  json?: boolean | undefined
  limit?: number | undefined
  /** LEARN-4 step 7's text. Required by `mark`. */
  outcome?: string | undefined
  /** LEARN-5's correct tool. Required by `label`. */
  tool?: string | undefined
  examplesFile?: string | undefined
  /** Injected by tests, so no key and no network are needed (DEP-3). */
  store?: Store | undefined
}

const USAGE = `openbox review - the flags nobody has looked at yet (LEARN-4)

  openbox review [list]              the backlog, grouped by likely cause
  openbox review show <flag-id>      one flagged conversation in full
  openbox review mark <flag-id...> --outcome "<what came of it>"
  openbox review label <flag-id> --tool <name>

Options:
  --json                 machine readable, for list and show
  --limit <n>            how many flags to read. Defaults to 50
  --dir <dir>            the agent project. Defaults to this folder
  --examples <file>      defaults to ${ROUTING_EXAMPLES_FILE}
`

/** How many flags a review reads in one go unless told otherwise. */
export const DEFAULT_LIMIT = 50

const short = (at: string): string => at.slice(0, 16).replace("T", " ")

/** One flag as a line in the backlog. */
function flagLine(conversation: FlaggedConversation): string {
  const { flag, person } = conversation
  const who = person === null ? "unknown" : `${person.channel}:${person.channel_user_id}`
  return `  ${flag.id}  ${flag.kind}  ${who}  ${short(flag.created_at)}\n    ${conversation.why}`
}

/** LEARN-4 steps 1 and 2, as a builder reads them. */
export function backlogText(groups: CauseGroup[]): string {
  const total = groups.reduce((count, group) => count + group.conversations.length, 0)
  if (total === 0) return "Nothing to review: every flag has been looked at.\n"

  const lines = [`${total} flag${total === 1 ? "" : "s"} waiting, oldest first.`, ""]
  for (const group of groups) {
    lines.push(`${group.cause} (${group.conversations.length})`)
    for (const conversation of group.conversations) lines.push(flagLine(conversation))
    lines.push("")
  }
  lines.push(
    "A cause is proposed from the trace, not decided. Read the conversation",
    "before you act on one, and `unclear` means the trace could not say.",
    "",
    "  openbox review show <flag-id>",
  )
  return `${lines.join("\n")}\n`
}

/** One flagged conversation, in the order it happened. */
export function conversationText(conversation: FlaggedConversation): string {
  const { flag, person, turn, messages, toolRuns, decisions } = conversation
  const lines = [
    `flag ${flag.id}  ${flag.kind}  ${short(flag.created_at)}`,
    `cause ${conversation.cause}: ${conversation.why}`,
    `detail ${JSON.stringify(flag.detail)}`,
  ]
  if (conversation.alsoFlagged.length > 0) {
    lines.push(`also on this turn: ${conversation.alsoFlagged.join(", ")}`)
  }
  lines.push(
    person === null
      ? "person: not found"
      : `person: ${person.display_name ?? "no name"} on ${person.channel} as ${person.role}`,
  )
  if (turn !== null) {
    lines.push(
      `turn: ${turn.steps} steps, ${turn.outcome ?? "no outcome"}, ${turn.latency_ms ?? "?"} ms, version ${turn.version_id ?? "none"}`,
    )
  }

  lines.push("", "conversation:")
  for (const message of messages) {
    const text = message.text ?? message.transcript ?? `[${message.media_ref ?? "no text"}]`
    lines.push(`  ${message.direction === "inbound" ? "person" : message.author} > ${text}`)
  }

  if (toolRuns.length > 0) {
    lines.push("", "tools:")
    for (const run of toolRuns) {
      lines.push(
        `  ${run.tool} (${run.risk}) ${run.status}${run.error === null ? "" : `: ${run.error}`}`,
        `    args ${JSON.stringify(run.args)}`,
      )
    }
  }

  if (decisions.length > 0) {
    lines.push("", "decisions:")
    for (const decision of decisions) {
      lines.push(`  ${decision.kind} ${decision.outcome} by ${decision.model}`)
    }
  }

  return `${lines.join("\n")}\n`
}

function parseLimit(limit: number | undefined, io: ChatIo): number | null {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    io.write(`--limit must be a whole number of flags, not "${String(limit)}".\n`)
    return null
  }
  return limit
}

/** LEARN-5: the corrected label, built from what that conversation was. */
export function labelFrom(conversation: FlaggedConversation, tool: string): RoutingLabel {
  const batch: string[] = []
  const before: { role: string; text: string }[] = []

  for (const message of conversation.messages) {
    const text = message.text ?? message.transcript
    if (text === null || text === "") continue
    // The flagged turn's own incoming messages are the batch routing was
    // asked about (ROUTE-1). Everything before it is the conversation.
    if (message.turn_id === conversation.flag.turn_id && message.direction === "inbound") {
      batch.push(text)
    } else {
      before.push({ role: message.direction === "inbound" ? "user" : "assistant", text })
    }
  }

  return {
    batch,
    ...(before.length > 0 ? { messages: before } : {}),
    tool,
    ...(conversation.person !== null ? { role: conversation.person.role } : {}),
  }
}

/** Runs one `openbox review` subcommand. Returns the exit code. */
export async function runReview(options: ReviewOptions = {}): Promise<number> {
  const io = options.io ?? stdio()
  const env = options.env ?? process.env
  const args = options.args ?? []
  const command = args[0] ?? "list"

  if (!["list", "show", "mark", "label"].includes(command)) {
    io.write(`Unknown review subcommand: ${command}\n\n${USAGE}`)
    return 1
  }

  let project: Awaited<ReturnType<typeof loadProject>>
  try {
    project = await loadProject(options)
  } catch (error) {
    if (error instanceof ProjectError) {
      io.write(`${error.message}\n`)
      return 1
    }
    throw error
  }

  let store: Store
  try {
    store = options.store ?? createStore(supabaseFromEnv(env), project.config.name)
  } catch (error) {
    if (error instanceof ProviderError) {
      io.write(`${error.message}\nSet the missing keys, then run openbox review again.\n`)
      return 1
    }
    throw error
  }

  const limit = parseLimit(options.limit, io)
  if (limit === null) return 1

  if (command === "list") {
    const groups = await reviewBacklog({ store, limit })
    io.write(options.json === true ? `${JSON.stringify(groups, null, 2)}\n` : backlogText(groups))
    return 0
  }

  const ids = args.slice(1)
  if (ids.length === 0) {
    io.write(`${command} needs a flag id.\n\n${USAGE}`)
    return 1
  }

  if (command === "mark") {
    const outcome = options.outcome ?? ""
    if (outcome.trim() === "") {
      io.write("mark needs --outcome with what came of the flag (LEARN-4 step 7).\n")
      return 1
    }
    const marked = await markReviewed({ store, flagIds: ids, outcome })
    io.write(`Marked ${marked.length} of ${ids.length} reviewed: ${outcome}\n`)
    // Named rather than counted: a flag somebody else reviewed first keeps
    // their outcome, and a reviewer who is not told would think theirs landed.
    const missed = ids.filter((id) => !marked.some((flag) => flag.id === id))
    if (missed.length > 0) {
      io.write(`Already reviewed, or not this agent's, so left alone: ${missed.join(", ")}\n`)
    }
    return marked.length === ids.length ? 0 : 1
  }

  const id = ids[0] as string
  const flag = await store.flags.byId(id)
  if (flag === null) {
    io.write(`No flag ${id} for this agent.\n`)
    return 1
  }
  const conversation = await flaggedConversation(store, flag)

  if (command === "show") {
    io.write(
      options.json === true
        ? `${JSON.stringify(conversation, null, 2)}\n`
        : conversationText(conversation),
    )
    return 0
  }

  // label: LEARN-5.
  const tool = options.tool ?? ""
  if (tool === "") {
    io.write("label needs --tool with the tool that should have been chosen (LEARN-5).\n")
    return 1
  }
  const knownTools = project.tools.map((candidate) => candidate.name)
  const path = options.examplesFile ?? ROUTING_EXAMPLES_FILE
  const file = isAbsolute(path) ? path : resolve(project.dir, path)
  let text = ""
  try {
    text = readFileSync(file, "utf8")
  } catch {
    // A project that has never had a reviewed decision has no file yet.
    text = ""
  }

  const label = labelFrom(conversation, tool)
  if (label.batch.length === 0) {
    io.write(`Flag ${id} has no incoming message on its turn, so there is nothing to label.\n`)
    return 1
  }

  const problems = parseRoutingJsonl(text, path, knownTools).problems
  if (problems.length > 0) {
    io.write(`${path} has problems, so nothing was appended:\n`)
    for (const problem of problems) io.write(`  - ${problem}\n`)
    return 1
  }

  let result: ReturnType<typeof appendRoutingExample>
  try {
    result = appendRoutingExample(text, label, knownTools)
  } catch (error) {
    io.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  if (!result.appended) {
    io.write(`${path} already labels that conversation (${result.existing ?? "?"}).\n`)
    return 1
  }

  // An agent that has never had a reviewed decision has no examples
  // folder, and LEARN-5's whole point is the first label.
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, withRoutingLine(text, result.line), "utf8")
  io.write(`Appended to ${path}:\n  ${result.line}\nRun openbox tune to see what it changes.\n`)
  return 0
}
