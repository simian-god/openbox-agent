// LEARN-4: the data behind the skill's `review` command.
//
// The command itself is the skill's, and most of it is judgment: reading a
// conversation, deciding what went wrong, proposing a diff, writing an
// evals-agent case. None of that belongs in the core. What does belong
// here is everything a wrong answer would be invisible in:
//
//   which flags are still unreviewed, in the order they happened
//   the conversation behind one of them, read once rather than guessed at
//   a proposed cause, from the trace rather than from the prose
//   marking a flag reviewed, exactly once, with what came of it
//
// Two rules shape the rest of this file.
//
// **The cause is proposed, not decided.** LEARN-4 step 2 groups flags by
// likely cause, and for some kinds the trace says it outright: a tool that
// threw is a tool bug, a tool the brain invented is a missing tool. For
// `frustration` or an operator's own flag it does not, and a confident
// wrong group sends the reviewer at the wrong fix. So those are grouped as
// `unclear`, which is the one value here that is not in the Spec's list,
// and the skill reads the conversation before moving them.
//
// **Marking is a claim, not a write.** Two reviews of one backlog would
// otherwise each write their own outcome over the other's, and the second
// would look like it had done the work. `markReviewed` is DATA-4's
// conditional update on `reviewed_at is null`, so a flag is marked once
// and the loser is told which ones it did not get.
import { systemClock, type Clock } from "../testing/clock.ts"
import type {
  DecisionRow,
  FlagKind,
  FlagRow,
  MessageRow,
  PersonRow,
  Store,
  ToolRunRow,
  TurnRow,
} from "../store/index.ts"

/**
 * LEARN-4 step 2's groups.
 *
 * The Spec's six, with "conditions too strict or too loose" kept as two
 * because they are opposite fixes, plus `unclear` for a flag the trace
 * cannot explain on its own.
 */
export const CAUSES = [
  "missing knowledge",
  "wrong routing",
  "conditions too strict",
  "conditions too loose",
  "prompt gap",
  "tool bug",
  "missing tool",
  "unclear",
] as const

export type Cause = (typeof CAUSES)[number]

/** What the trace says, and why it says it. */
export interface ProposedCause {
  cause: Cause
  /** One line naming the evidence, so a reviewer can disagree with it. */
  why: string
}

/** The tool a flag was about, when its detail names one. */
export function toolOf(flag: FlagRow): string | null {
  const named = flag.detail["tool"] ?? flag.detail["choice"]
  return typeof named === "string" && named !== "" ? named : null
}

/** A handover's own reason, which is more specific than the flag kind. */
function handoverCause(reason: string, detail: string | null): ProposedCause {
  switch (reason) {
    case "escalate":
      return {
        cause: "missing knowledge",
        why: `the brain escalated${detail === null ? "" : `: ${detail}`}, so it had no answer to give`,
      }
    case "gate_block_repeat":
      return {
        cause: "conditions too strict",
        why: "two gate Blocks in a row for the same person (GATE-3)",
      }
    case "low_confidence_repeat":
      return { cause: "wrong routing", why: "routing was unsure twice in a row (LOOP-10)" }
    case "tool_failed_repeat":
      return { cause: "tool bug", why: "the same tool failed twice in a row (LOOP-10)" }
    case "step_cap":
      return {
        cause: "prompt gap",
        why: "the turn ran out of steps, which is usually a missing stop condition (LOOP-9)",
      }
    case "wants_human":
      return { cause: "unclear", why: "the person asked for a human, which may be no fault at all" }
    case "spend_cap":
      return { cause: "unclear", why: "the daily spend cap was reached (LIMIT-3), not a fault" }
    case "brains_failed":
      return { cause: "unclear", why: "every brain failed (LOOP-12), which is a provider outage" }
    default:
      return { cause: "unclear", why: `handover opened as ${reason}` }
  }
}

/**
 * LEARN-4 step 2: the cause this flag is grouped under to begin with.
 *
 * Read from the kind and the detail the flag was raised with, which is why
 * those details are recorded in the first place.
 */
export function causeOf(flag: FlagRow): ProposedCause {
  const tool = toolOf(flag)

  switch (flag.kind) {
    case "unknown_tool": {
      const offered = flag.detail["offered"]
      const list = Array.isArray(offered) ? offered.join(", ") : ""
      return {
        cause: "missing tool",
        why: `the brain called ${tool ?? "a tool"} and was offered ${list === "" ? "nothing" : list}: either the tool is missing or the prompt promised it`,
      }
    }
    case "tool_error": {
      const timeout = flag.detail["timeout"] === true
      return {
        cause: "tool bug",
        why: `${tool ?? "a tool"} ${timeout ? "timed out" : "failed"}: ${String(flag.detail["error"] ?? "no error recorded")}`,
      }
    }
    case "low_confidence":
      return {
        cause: "wrong routing",
        why: `routing picked ${tool ?? "a tool"} below the threshold, so every tool was shown (ROUTE-2)`,
      }
    case "gate_block":
      return {
        cause: "conditions too strict",
        why: `the gate blocked ${tool ?? "a call"}, so either its conditions rule out a call the person should get, or the person should have been told why`,
      }
    case "step_cap":
      return {
        cause: "prompt gap",
        why: "the turn hit the step cap, which is usually a missing stop condition (LOOP-9)",
      }
    case "confirmation_rejected":
      return {
        cause: "unclear",
        why: `a confirm was rejected: ${String(flag.detail["why"] ?? "no reason recorded")}. CONF-4 doing its job is not a fault`,
      }
    case "send_blocked":
      return {
        cause: "unclear",
        why: `a message could not be sent on ${String(flag.detail["channel"] ?? "the channel")}: ${String(flag.detail["why"] ?? "a channel rule")}`,
      }
    case "frustration":
      return {
        cause: "unclear",
        why: "the person sounded frustrated, and only the conversation says what about",
      }
    case "operator":
      return {
        cause: "unclear",
        why: `an operator flagged this${flag.detail["note"] === undefined ? "" : `: ${String(flag.detail["note"])}`}`,
      }
    case "handover":
      return handoverCause(
        String(flag.detail["reason"] ?? "unknown"),
        typeof flag.detail["detail"] === "string" ? flag.detail["detail"] : null,
      )
    default:
      return { cause: "unclear", why: `flag kind ${String(flag.kind)}` }
  }
}

/** LEARN-4 step 1: one flag, and everything the review needs around it. */
export interface FlaggedConversation {
  flag: FlagRow
  cause: Cause
  why: string
  person: PersonRow | null
  /** The flagged turn, when the flag was raised inside one. */
  turn: TurnRow | null
  /** The conversation, oldest first: the window around the flag. */
  messages: MessageRow[]
  /** What the tools did on that turn, in order. */
  toolRuns: ToolRunRow[]
  /** What the decision model was asked on that turn, and what it said. */
  decisions: DecisionRow[]
  /** Every other flag on the same turn: one fault often raises several. */
  alsoFlagged: FlagKind[]
}

/** How many messages of a conversation a review reads by default. */
export const MESSAGE_WINDOW = 20

export interface BacklogOptions {
  store: Store
  /** The newest flags are the ones a review acts on, so this bounds it. */
  limit?: number | undefined
  messageWindow?: number | undefined
}

/**
 * LEARN-4 step 1: the flags nobody has reviewed, oldest first.
 *
 * Oldest first because a fault usually shows up more than once, and the
 * first time it did is the one with the cleanest conversation around it.
 */
export async function unreviewedFlags(options: BacklogOptions): Promise<FlagRow[]> {
  return options.store.flags.list(
    {},
    {
      orderBy: "seq",
      ascending: true,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      range: { is: { reviewed_at: null } },
    },
  )
}

/** LEARN-4 step 1: one flag's conversation, read rather than guessed at. */
export async function flaggedConversation(
  store: Store,
  flag: FlagRow,
  options: { messageWindow?: number | undefined } = {},
): Promise<FlaggedConversation> {
  const { cause, why } = causeOf(flag)
  const window = options.messageWindow ?? MESSAGE_WINDOW

  const person = await store.people.byId(flag.person_id)
  const turn = flag.turn_id === null ? null : await store.turns.byId(flag.turn_id)

  // The newest `window` messages, then put back in the order they were
  // said. Reading ascending would hand back the start of a conversation
  // that has been going for a month.
  const recent = await store.messages.list(
    { person_id: flag.person_id },
    { orderBy: "seq", ascending: false, limit: window },
  )
  const messages = [...recent].reverse()

  const forTurn = flag.turn_id === null ? null : { turn_id: flag.turn_id }
  const toolRuns =
    forTurn === null ? [] : await store.toolRuns.list(forTurn, { orderBy: "seq", ascending: true })
  const decisions =
    forTurn === null ? [] : await store.decisions.list(forTurn, { orderBy: "seq", ascending: true })
  const sameTurn =
    forTurn === null ? [] : await store.flags.list(forTurn, { orderBy: "seq", ascending: true })

  return {
    flag,
    cause,
    why,
    person,
    turn,
    messages,
    toolRuns,
    decisions,
    alsoFlagged: sameTurn.filter((other) => other.id !== flag.id).map((other) => other.kind),
  }
}

/** LEARN-4 step 2: the backlog, grouped by the cause each flag proposes. */
export interface CauseGroup {
  cause: Cause
  conversations: FlaggedConversation[]
}

/**
 * Biggest group first, because the fix that clears the most flags is the
 * one to look at first. Ties go in `CAUSES` order, so two runs of the same
 * backlog read the same way.
 */
export function groupByCause(conversations: FlaggedConversation[]): CauseGroup[] {
  const byCause = new Map<Cause, FlaggedConversation[]>()
  for (const conversation of conversations) {
    const found = byCause.get(conversation.cause)
    if (found === undefined) byCause.set(conversation.cause, [conversation])
    else found.push(conversation)
  }

  return [...byCause.entries()]
    .map(([cause, group]) => ({ cause, conversations: group }))
    .sort(
      (left, right) =>
        right.conversations.length - left.conversations.length ||
        CAUSES.indexOf(left.cause) - CAUSES.indexOf(right.cause),
    )
}

/** LEARN-4 step 1 and 2 together: the backlog a review starts from. */
export async function reviewBacklog(options: BacklogOptions): Promise<CauseGroup[]> {
  const flags = await unreviewedFlags(options)
  const conversations: FlaggedConversation[] = []
  for (const flag of flags) {
    conversations.push(
      await flaggedConversation(options.store, flag, {
        ...(options.messageWindow !== undefined ? { messageWindow: options.messageWindow } : {}),
      }),
    )
  }
  return groupByCause(conversations)
}

export interface MarkReviewedOptions {
  store: Store
  flagIds: string[]
  /** LEARN-4 step 7: what came of it, in the reviewer's own words. */
  outcome: string
  /** TIME-1: the real clock is read in one place and injected from it. */
  clock?: Clock | undefined
}

/**
 * LEARN-4 step 7: marks flags reviewed, with the outcome.
 *
 * Returns the flags this call actually marked. A flag somebody else
 * reviewed first is not in that list and keeps their outcome, because the
 * update is conditional on `reviewed_at` still being null (DATA-4). A
 * review that silently overwrote another's would lose the only record of
 * what was decided.
 */
export async function markReviewed(options: MarkReviewedOptions): Promise<FlagRow[]> {
  const { store, flagIds, outcome } = options
  if (outcome.trim() === "") {
    throw new Error("markReviewed needs an outcome: LEARN-4 step 7 records what came of the flag")
  }
  if (flagIds.length === 0) return []

  const at = (options.clock ?? systemClock).now().toISOString()
  return store.flags.update(
    {},
    { reviewed_at: at, review_outcome: outcome },
    { isIn: { id: flagIds }, is: { reviewed_at: null } },
  )
}
