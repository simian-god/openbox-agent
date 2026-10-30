// The M9 check, from Plan.md: "C19 passes, plus the core side of C20
// (flags raised, digest correct). C21 (erase, export and retention) is
// parked with T9.3, at the builder's decision on 2026-10-28."
//
// C19 is the Intent's nineteenth criterion: "With each dependency failed
// in turn (brain, decision model, a tool, the sender, then all at once),
// no message is lost, and the person always gets an answer or the holding
// message. A decision model outage never lets an irreversible tool run."
//
// C20's first bullet is the core side: "Every flag type is raised by a
// case built to trigger it, and the weekly digest arrives with correct
// counts." Its other three bullets are a review run on real flags, which
// is T10.6, and an evals-agent case, which is T11.2. They are listed here
// rather than left out, so the report says what this bar does not cover.
//
// Same shape as m4, m6, m7 and m8, and for the same reason: a clause of
// the bar is a claim about behaviour, and behaviour is what the suite
// already asserts. This names the test that proves each clause, runs those
// files, and fails if a clause has no passing test behind it. Asserting
// the same things a second time would be a second implementation to keep
// in step, and the first time the two disagreed nobody would know which to
// believe.
//
// One thing to know before reading a PASS here. C19 is a claim about
// dependencies, and every dependency failure is handled inside the turn.
// There is one way to end a turn that keeps "no message is lost" and drops
// "the person always gets an answer": a throw the core had no plan for.
// Nothing a dependency does reaches it, which is why C19 passes as
// written, and it is pinned by a test rather than wished away. That is
// Known K30, and this check prints it under the verdict rather than
// leaving a reader to find it out later.
//
// Usage: bun run m9-check
import { join } from "node:path"
import {
  type ClauseState,
  describeClause,
  NO_DATABASE,
  type Outcome,
  runSuite,
} from "./support/results.ts"

const root = join(import.meta.dir, "..")

/** The files that hold M9's proof. */
const FILES = [
  "packages/core/test/unit/events.test.ts",
  "packages/core/test/unit/digest.test.ts",
  "packages/core/test/integration/sweep.test.ts",
  "packages/core/test/integration/turn.test.ts",
  "packages/core/test/integration/events.test.ts",
  "packages/core/test/integration/deadlines.test.ts",
  "packages/core/test/integration/confirm.test.ts",
  "packages/core/test/integration/limits.test.ts",
  "packages/core/test/integration/sendrules.test.ts",
  "packages/core/test/integration/operator.test.ts",
  "packages/core/test/integration/handover.test.ts",
  "packages/core/test/integration/digest.test.ts",
]

type Part =
  | "brain"
  | "decision"
  | "tool"
  | "sender"
  | "all"
  | "turns"
  | "flags"
  | "digest"
  | "later"
  | "parked"

interface Clause {
  part: Part
  /** The clause, in the criterion's own words where it has them. */
  what: string
  /** Part of the name of a test that proves it. */
  test: string
  /**
   * Why this clause cannot pass yet, and what would fix it. A clause with
   * this set still does not pass: it is here so the report says which
   * failures are scheduled and which are news.
   */
  waitingOn?: string
  /**
   * A clause that passes and still leaves something a reader should know.
   * Printed under the verdict, so a PASS is never read as more than it is.
   */
  limit?: string
}

const CLAUSES: Clause[] = [
  // C19, one dependency at a time, in the criterion's own order. Every
  // case is measured on the same two bars by `expectSwept`, which is not
  // told what broke: nothing lost means the message is linked to the turn
  // that handled it and marked done only if something was written in
  // answer to it, and always an answer means a real reply or one of the
  // fixed holding lines.
  {
    part: "brain",
    what: "every brain in the chain fails and the person still hears something",
    test: "C19: every brain down, and the person still hears something",
  },
  {
    part: "brain",
    what: "and the holding message's promise has an owner, so it is not a lie",
    test: "LOOP-12: and a colleague is given the promise the agent just made",
  },
  {
    part: "brain",
    what: "one brain of two is not a failure at all: the fallback answers (BRAIN-5)",
    test: "C19: one brain down out of two is not a failure at all",
  },

  {
    part: "decision",
    what: "the decision model down and the person is still answered, by the brain",
    test: "C19: the decision model down, and the person is still answered",
  },
  {
    part: "decision",
    what: "routing fails open, so no tool becomes unreachable (ROUTE-5)",
    test: "ROUTE-5: with no answer about which tools to offer, every tool is offered",
  },
  {
    part: "decision",
    what: "the gate fails closed, so a write does not run unasked (GATE-4)",
    test: "GATE-4: a write does not run while the gate cannot be answered",
  },
  {
    part: "decision",
    what: "the criterion's own last sentence: an outage never lets an irreversible tool run",
    test: "C19: a decision model outage never lets an irreversible tool run",
  },
  {
    part: "decision",
    what: "it is put to the person instead, which is why an outage takes no bookings away",
    test: "GATE-4: and the irreversible call is still put to the person",
  },
  {
    part: "decision",
    what: "and that action is held to every CONF-4 rule, so a stolen button still runs nothing",
    test: "CONF-4: an action asked for during an outage is no weaker than any other",
  },
  {
    part: "decision",
    what: "a write is unchanged: Confirm in words, no pending action, no signed button",
    test: "GATE-4: a write is still only treated as Confirm, and asks nobody",
  },

  {
    part: "tool",
    what: "a tool that throws goes back to the brain, not back to the person",
    test: "C19: a tool that throws is answered around, not passed on",
  },
  {
    part: "tool",
    what: "the same tool failing twice in a row is a handover (LOOP-10)",
    test: "LOOP-10: the same tool failing twice in a row is a handover",
  },
  {
    part: "tool",
    what: "and the failure is flagged, so a builder reads about it",
    test: "LEARN-1: a tool error is flagged, so a builder reads about it",
  },
  {
    part: "tool",
    what: "a tool that never answers is the same failure, and says it was a timeout",
    test: "LEARN-1: a tool that times out raises a tool_error flag marked as a timeout",
  },

  {
    part: "sender",
    what: "the answer is written down before it is sent, so a dead sender loses nothing",
    test: "C19: the sender down leaves the answer written down, not lost",
  },
  {
    part: "sender",
    what: "and it is tried again only where a repeat is invisible to the person (SEND-1)",
    test: "C19: on a channel where a repeat is invisible, it is tried again",
  },

  {
    part: "all",
    what: "all four down at once and the message is still not lost",
    test: "C19: everything down, and the message is still not lost",
  },
  {
    part: "all",
    what: "the handover still opens, so the promise still has an owner",
    test: "C19: with everything down the handover is still opened",
  },
  {
    part: "all",
    what: "and nothing is thrown back at the channel, which would retry the webhook",
    test: "C19: and nothing is thrown back at the channel",
  },

  {
    part: "turns",
    what: "each in turn in one conversation: four turns, four answers",
    test: "C19: four turns, one dependency broken in each, four answers",
  },
  {
    part: "turns",
    what: "and where C19's second half stops, pinned rather than wished away",
    test: "C19: the row stays findable, and this is where C19's second half stops",
    limit:
      "A throw the core had no plan for leaves the inbox row findable and fires onTurnError, " +
      "and tells the person nothing. Nothing a dependency does reaches that path, which is " +
      "why C19 passes as written: what reaches it is a bug in the core or in a builder's " +
      "channel glue. Known K30 writes out three options and waits on the builder",
  },

  // The core side of C20, first half: a case per flag kind. LEARN-1's
  // table has ten, and a kind nothing raises is a flag the digest will
  // never count and nobody will ever review.
  {
    part: "flags",
    what: "handover: any handover starting raises one",
    test: "HAND-2: it is in the trace, and it is a flag",
  },
  {
    part: "flags",
    what: "gate_block: a call the gate refused",
    test: "LEARN-1: a Block raises a gate_block flag",
  },
  {
    part: "flags",
    what: "low_confidence: a routing pick below the threshold",
    test: "LEARN-1: a routing pick below the threshold raises a low_confidence flag",
  },
  {
    part: "flags",
    what: "tool_error: a tool that threw",
    test: "LEARN-1: a tool that throws raises a tool_error flag",
  },
  {
    part: "flags",
    what: "tool_error: and a tool that never answered, marked as the timeout it was",
    test: "LEARN-1: a tool that times out raises a tool_error flag marked as a timeout",
  },
  {
    part: "flags",
    what: "unknown_tool: a call to a tool the brain was never offered",
    test: "LEARN-1: a tool the brain was not offered raises an unknown_tool flag",
  },
  {
    part: "flags",
    what: "frustration: a person who sounds angry, with the score that did it",
    test: "LEARN-1: an angry person is flagged, with the score that did it",
  },
  {
    part: "flags",
    what: "step_cap: a turn that ran out of steps",
    test: "LIMIT-2 and LOOP-9: the step cap tells the person, flags the turn and hands over",
  },
  {
    part: "flags",
    what: "confirmation_rejected: a confirm refused, with the rule that refused it",
    test: "LEARN-1: a refused confirm raises a confirmation_rejected flag, with the rule",
  },
  {
    part: "flags",
    what: "send_blocked: a free text message outside the channel's window (PRO-3)",
    test: "PRO-3: outside the window, free text fails and is flagged",
  },
  {
    part: "flags",
    what: "operator: an operator flagging a conversation by hand",
    test: "flag raises an operator flag against the person, not the operator",
  },
  {
    part: "flags",
    what: "every kind the Spec's table lists exists in the code, and the code invents none",
    test: "LEARN-1: every kind in the Spec's table exists in the code",
  },
  {
    part: "flags",
    what: "and every one of them is raised somewhere, which is what found the four that were not",
    test: "LEARN-1: every kind the Spec lists is raised somewhere in the core",
  },
  {
    part: "flags",
    what: "the database accepts exactly those kinds, so a flag cannot be lost on insert",
    test: "LEARN-1: the migration accepts exactly those kinds and no others",
  },
  {
    part: "flags",
    what: "a flag is a row and an event, so a run reads without a join",
    test: "LEARN-1: a flag is a row and an event, so neither has to be joined",
  },

  // The core side of C20, second half: "the weekly digest arrives with
  // correct counts". Arriving is the booking and the send, correct is the
  // counting.
  {
    part: "digest",
    what: "it arrives: booked on the right Monday at nine, in the agent's timezone",
    test: "LEARN-3: starting books the next digest, on the right Monday at nine",
  },
  {
    part: "digest",
    what: "and keeps itself going, because the handler books the one after",
    test: "LEARN-3: sending it books the next week's digest",
  },
  {
    part: "digest",
    what: "the loop runs it when its Monday comes, with nobody asking",
    test: "LEARN-3: the loop runs it when its Monday comes, with nobody asking",
  },
  {
    part: "digest",
    what: "it goes to the builder's channel",
    test: "LEARN-3: the digest goes to the builder's channel",
  },
  {
    part: "digest",
    what: "counts by kind, against the week before, which is what makes a count mean anything",
    test: "LEARN-3: flag counts by kind, compared with the week before",
  },
  {
    part: "digest",
    what: "a flag outside both weeks counts in neither",
    test: "LEARN-3: a flag older than the two weeks counts in neither",
  },
  {
    part: "digest",
    what: "one agent never counts another's flags (DATA-1)",
    test: "LEARN-3: one agent never counts another's flags",
  },
  {
    part: "digest",
    what: "spend and median latency come from the week's own turns",
    test: "LEARN-3: spend and median latency come from the week's turns",
  },
  {
    part: "digest",
    what: "the median is the middle value, so one slow turn does not read as a bad week",
    test: "LEARN-3: it is the middle value, not the average",
  },
  {
    part: "digest",
    what: "the five most flagged conversations, and no more than five",
    test: "LEARN-3: the five worst conversations, and no more than five",
  },
  {
    part: "digest",
    what: "a week the agent was down for goes out late, covering the week it was due for",
    test: "LEARN-3: a digest that runs late covers the week it was due for",
  },
  {
    part: "digest",
    what: "a quiet week still goes out, so silence is reported rather than assumed",
    test: "LEARN-3: a quiet week still goes out, so silence is reported too",
  },
  {
    part: "digest",
    what: "and the same week is never sent twice, whatever retries happen (PRO-1)",
    test: "LEARN-3: the same week is never sent twice, whatever retries happen",
  },
  {
    part: "digest",
    what: "no builder channel means no digest, said out loud rather than failing quietly",
    test: "LEARN-3: it still starts, and says why no digest will come",
  },

  // C20's other three bullets. Not the core side, and named so the report
  // says what this bar does not cover.
  {
    part: "later",
    what: "the review turns a flagged conversation into an evals-agent case that fails before the fix and passes after it",
    test: "nothing in this repo proves this",
    waitingOn:
      "T10.6, which builds `review` and the export of flagged conversations as evals-agent " +
      "cases (LEARN-4). The flags it would read are what T9.1 finished raising",
  },
  {
    part: "later",
    what: "nothing goes live without the builder's approval",
    test: "nothing in this repo proves this end to end",
    waitingOn:
      "T10.6, for `review` and `tune` applying nothing without approval (LEARN-7). The one " +
      "piece that exists is `openbox tune`, which reports and writes nothing without " +
      "--write, proven in M3's rows",
  },
  {
    part: "later",
    what: "after an operator answer is approved as knowledge, the same question is answered without a handover",
    test: "nothing in this repo proves this end to end",
    waitingOn:
      "T11.2's evals-agent cases. The core half is proven in M6's and M8's bars, where an " +
      "approved candidate becomes searchable at once with no restart (KNOW-2) and a " +
      "knowledge answer reaches the person (C18). What nothing here joins up is the same " +
      "question being answered afterwards with no handover at all",
  },

  // C21, which the bar names as parked. Listed clause by clause so the
  // parking is a decision a reader can see rather than an omission.
  {
    part: "parked",
    what: "the first contact notice is recorded (PRIV-1)",
    test: "nothing in this repo proves this",
    waitingOn: "T9.3, parked by the builder on 2026-10-28 (Known K15)",
  },
  {
    part: "parked",
    what: "erasing a person removes their messages, facts and tasks, keeping only the minimal log (PRIV-3)",
    test: "nothing in this repo proves this",
    waitingOn:
      "T9.3, parked. Erasure is a judgement about what goes, what is redacted to ids and " +
      "timestamps and what row proves it happened, and deleting too much cannot be walked back",
  },
  {
    part: "parked",
    what: "export returns everything stored about them (PRIV-4)",
    test: "nothing in this repo proves this",
    waitingOn: "T9.3, parked",
  },
  {
    part: "parked",
    what: "data older than the retention period is deleted on schedule (PRIV-2)",
    test: "nothing in this repo proves this",
    waitingOn:
      "T9.3, parked. `notice` and `retentionDays` are still required in config and still " +
      "enforced by nothing at runtime, which is the cost written down in Known K15",
  },
]

export interface ClauseResult extends Clause {
  pass: boolean
  state: ClauseState
  detail: string
}

export function checkClauses(results: Map<string, Outcome>): ClauseResult[] {
  return CLAUSES.map((clause) => ({
    ...clause,
    ...describeClause(results, clause.test, clause.waitingOn),
  }))
}

const TITLES: Record<Part, string> = {
  brain: "C19: the brain",
  decision: "C19: the decision model",
  tool: "C19: a tool",
  sender: "C19: the sender",
  all: "C19: all four at once",
  turns: "C19: across one conversation, and where its second half stops",
  flags: "the core side of C20: a case per flag kind",
  digest: "the core side of C20: the weekly digest, with correct counts",
  later: "the rest of C20, which this bar leaves to M10 and M11",
  parked: "C21, parked with T9.3 by the builder's decision",
}

const ORDER = Object.keys(TITLES) as Part[]

/**
 * A clause whose failure is news rather than a schedule.
 *
 * A failing test counts whether or not the clause says it is waiting,
 * which the other checks do not do: there, `waitingOn` swallows any
 * outcome, so a waiting clause that grew a real test and broke it would
 * print `wait` and pass the command. No clause is in that state today,
 * since every waiting one names a test that does not exist, so this is
 * the hole closed before anything falls in it.
 */
function isNews(clause: ClauseResult): boolean {
  if (clause.state === "fail") return true
  return !clause.pass && clause.state !== "skip" && clause.waitingOn === undefined
}

export function format(clauses: ClauseResult[], ran: number): string {
  const lines = ["", "================ M9 check ================", ""]
  lines.push(`${ran} tests ran across ${FILES.length} files, on the scripted brain and`)
  lines.push("the scripted decision model, with frozen clocks. No keys, no network.")

  for (const part of ORDER) {
    const mine = clauses.filter((clause) => clause.part === part)
    const ok = mine.every((clause) => clause.pass)
    const unrun = mine.filter((clause) => clause.state === "skip")
    const scheduled = mine.filter(
      (clause) => !clause.pass && clause.state === "missing" && clause.waitingOn !== undefined,
    )
    const news = mine.filter(isNews)

    // Order matters. A real failure outranks a skip, and a skip outranks
    // a clause that is only waiting: the worst news goes in the heading.
    const verdict = ok
      ? "PASS"
      : news.length > 0
        ? "FAIL"
        : unrun.length > 0
          ? `UNRUN (${unrun.length} of ${mine.length} clause(s) did not run)`
          : `WAIT  (${scheduled.length} clause(s) not proven here)`
    lines.push("", `${verdict}  ${TITLES[part]}`)
    for (const clause of mine) {
      const mark = clause.pass
        ? "ok  "
        : clause.state === "skip"
          ? "skip"
          : clause.waitingOn === undefined
            ? "FAIL"
            : "wait"
      lines.push(`      ${mark} ${clause.what}`)
      if (!clause.pass) lines.push(`           ${clause.detail}`)
    }
  }

  const unrun = clauses.filter((clause) => clause.state === "skip")
  const news = clauses.filter(isNews)

  lines.push("")
  if (unrun.length > 0) {
    lines.push(
      `${unrun.length} clause(s) rest on tests that were skipped, so nothing is proven.`,
      NO_DATABASE,
    )
    return lines.join("\n")
  }
  if (news.length > 0) {
    lines.push(`${news.length} clause(s) have no passing test. That is news, not a schedule.`)
    return lines.join("\n")
  }

  lines.push("The bar passes: C19 whole, plus the core side of C20.")
  for (const clause of clauses.filter((clause) => clause.pass && clause.limit !== undefined)) {
    lines.push("", `One limit a PASS here does not cover: ${clause.what}.`)
    lines.push(`  ${clause.limit ?? ""}`)
  }
  const waiting = clauses.filter((clause) => !clause.pass && clause.waitingOn !== undefined)
  if (waiting.length > 0) {
    lines.push(
      "",
      `${waiting.length} clause(s) wait on a later row or on a decision, which the bar itself says:`,
    )
    for (const clause of waiting)
      lines.push(`  - ${clause.what}`, `      ${clause.waitingOn ?? ""}`)
  }
  return lines.join("\n")
}

if (import.meta.main) {
  const { results, output } = runSuite(FILES, root, "m9")

  if (results.size === 0) {
    console.error("No test results were read. The suite did not run:\n")
    console.error(output.slice(-2000))
    process.exit(1)
  }

  const clauses = checkClauses(results)
  console.log(format(clauses, results.size))
  // A clause the bar itself says waits is not a surprise, so it does not
  // fail the command. What fails it is a clause that should have a passing
  // test and does not, a clause whose test did not run at all, which means
  // this check proved nothing, and a failing test behind any clause,
  // waiting or not.
  const unproven = clauses.filter(
    (clause) => !clause.pass && (clause.state === "skip" || isNews(clause)),
  )
  process.exit(unproven.length === 0 ? 0 : 1)
}
