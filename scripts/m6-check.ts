// The M6 check, from Plan.md: "C5, C11 and C12 pass."
//
// Same shape as m4-check, and for the same reason: all three criteria are
// claims about behaviour, and behaviour is what the suite already asserts.
// This names the test that proves each clause, runs those files, and fails
// if any clause has no passing test behind it. A check that asserted the
// same things a second time would be a second implementation to keep in
// step, and the first time they disagreed nobody would know which to
// believe.
//
// Two clauses are expected to fail here, and say so rather than being
// quietly left out. A third, C12's `approve_knowledge`, waited on T8.4
// until 2026-10-29 and now has a passing test:
//
// - C5 and C11 both end "checked by evals-agent cases", and the harness is
//   T11.2. What is checked here is the integration half, which is what the
//   Plan's own criteria map means by "M6, M11".
// - C12 wanted an operator to approve knowledge from their channel. T8.4
//   built `approve_knowledge` and `reject_knowledge`, so that clause and
//   its other half are checked here now and Known K18 is closed.
//
// Usage: bun run m6-check
import { join } from "node:path"
import {
  type ClauseState,
  type Outcome,
  describeClause,
  NO_DATABASE,
  runSuite,
} from "./support/results.ts"

const root = join(import.meta.dir, "..")

/** The files that hold M6's proof. */
const FILES = [
  "packages/core/test/integration/operator.test.ts",
  "packages/core/test/integration/handover.test.ts",
  "packages/core/test/integration/relay.test.ts",
  "packages/core/test/integration/timeout.test.ts",
  "packages/core/test/integration/knowledge.test.ts",
  "packages/core/test/integration/turn.test.ts",
]

interface Clause {
  criterion: "C5" | "C11" | "C12"
  /** The clause, in the Intent's own words. */
  what: string
  /** Part of the name of a test that proves it. */
  test: string
  /**
   * Why this clause cannot pass yet, and what will fix it. A clause with
   * this set still fails: it is here so the report says which failures are
   * scheduled and which are news.
   */
  waitingOn?: string
}

const CLAUSES: Clause[] = [
  // C5: "An end user can't trigger an operator only tool, and typing
  // 'I'm the owner' changes nothing, checked by evals-agent cases."
  {
    criterion: "C5",
    what: "an end user is never offered an operator tool",
    test: "ROLE-3: an operator is offered the operator tools and an end user is not",
  },
  {
    criterion: "C5",
    what: "a call to one is refused by name, and nothing happens",
    test: "C5: an end user's brain calling an operator tool is refused",
  },
  {
    criterion: "C5",
    what: "typing that you are the owner changes nothing",
    test: "C5: typing that you are the owner changes nothing",
  },
  {
    criterion: "C5",
    what: "a role claimed in the payload changes nothing either",
    test: "API-3: nothing in a message can set a role",
  },
  {
    criterion: "C5",
    what: "an operator's role survives their own messages",
    test: "ROLE-1: an operator's role survives a message from them",
  },
  {
    criterion: "C5",
    what: "the same, as hostile multi turn evals-agent cases",
    test: "evals-agent: an end user cannot reach an operator tool",
    waitingOn: "T11.2, the evals-agent adapter and its suites",
  },

  // C11: "Every trigger (asking for a human, the escalate tool, repeated
  // blocks or low confidence, repeated tool failures, operator take over)
  // hands over. The bot sends nothing to that person while handed over.
  // Control returns on resume or idle timeout, and the no operator timeout
  // sends the holding message."
  {
    criterion: "C11",
    what: "asking for a human hands over",
    test: "HAND-1: wants_human at the threshold opens one",
  },
  {
    criterion: "C11",
    what: "the escalate tool hands over",
    test: "HAND-1: escalate opens a handover, waiting",
  },
  {
    criterion: "C11",
    what: "two blocks in a row hand over",
    test: "GATE-3: two Blocks in a row for the same person is a handover trigger",
  },
  {
    criterion: "C11",
    what: "two low confidence picks in a row hand over",
    test: "GATE-3: two routing picks below the threshold in a row is the other trigger",
  },
  {
    criterion: "C11",
    what: "the same tool failing twice hands over",
    test: "LOOP-10: the same tool failing twice in a row opens one",
  },
  {
    criterion: "C11",
    what: "an operator's take over hands over, starting one if there is none",
    test: "HAND-1: an operator naming somebody not in a handover starts one",
  },
  {
    criterion: "C11",
    what: "the bot sends nothing to that person while handed over",
    test: "HAND-5: the agent does not answer a person in a handover",
  },
  {
    criterion: "C11",
    what: "and costs nothing either: no brain call, no decision request",
    test: "HAND-5: a person in a handover is still stored and still not answered",
  },
  {
    criterion: "C11",
    what: "control returns on resume",
    test: "HAND-7: resume closes it and the brain is told a handover happened",
  },
  {
    criterion: "C11",
    what: "control returns on the idle timeout",
    test: "HAND-7: half an hour of silence gives the person back to the agent",
  },
  {
    criterion: "C11",
    what: "the no operator timeout sends the holding message",
    test: "HAND-6: ten minutes on, the person is told and it becomes unanswered",
  },
  {
    criterion: "C11",
    what: "the same, as hostile multi turn evals-agent cases",
    test: "evals-agent: every handover trigger",
    waitingOn: "T11.2, the evals-agent adapter and its suites",
  },

  // C12: "An operator can take over, reply, resume, block and approve
  // knowledge entirely from their channel."
  {
    criterion: "C12",
    what: "take over, from a message on their channel",
    test: "HAND-3: the first operator to take it makes it active",
  },
  {
    criterion: "C12",
    what: "reply, word for word, from a message on their channel",
    test: "HAND-4: a focused operator's words go to the person, word for word",
  },
  {
    criterion: "C12",
    what: "resume, from a message on their channel",
    test: "C12: an operator resumes from their own channel",
  },
  {
    criterion: "C12",
    what: "block, from a message on their channel",
    test: "block blocks them, and their next message gets no reply",
  },
  {
    criterion: "C12",
    what: "see what is open, so they can pick one",
    test: "HAND-3: an operator can see what is open and who is on each",
  },
  {
    criterion: "C12",
    what: "approve knowledge, from a message on their channel",
    test: "KNOW-2: approving makes it searchable at once, with no restart",
  },
  {
    criterion: "C12",
    what: "and reject it, which is the same decision the other way",
    test: "LEARN-6: rejecting keeps the record and never makes it searchable",
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

export function format(clauses: ClauseResult[], ran: number): string {
  const lines = ["", "================ M6 check ================", ""]
  lines.push(`${ran} tests ran across ${FILES.length} files, on the scripted brain`)
  lines.push("and the scripted decision model. No keys, no network.")

  for (const criterion of ["C5", "C11", "C12"] as const) {
    const mine = clauses.filter((clause) => clause.criterion === criterion)
    const ok = mine.every((clause) => clause.pass)
    const unrun = mine.filter((clause) => clause.state === "skip")
    const scheduled = mine.filter(
      (clause) => !clause.pass && clause.state === "missing" && clause.waitingOn !== undefined,
    )
    const news = mine.filter(
      (clause) => !clause.pass && clause.state !== "skip" && clause.waitingOn === undefined,
    )

    // Order matters. A real failure outranks a skip, and a skip outranks
    // a clause that is only waiting: the worst news goes in the heading.
    const verdict = ok
      ? "PASS"
      : news.length > 0
        ? "FAIL"
        : unrun.length > 0
          ? `UNRUN (${unrun.length} of ${mine.length} clause(s) did not run)`
          : `PART  (${scheduled.length} clause(s) not built yet)`
    lines.push("", `${verdict}  ${criterion}`)
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
  const news = clauses.filter(
    (clause) => !clause.pass && clause.state !== "skip" && clause.waitingOn === undefined,
  )
  const scheduled = clauses.filter(
    (clause) => !clause.pass && clause.state === "missing" && clause.waitingOn !== undefined,
  )

  lines.push("")
  if (unrun.length > 0) {
    lines.push(
      `${unrun.length} clause(s) rest on tests that were skipped, so nothing is proven.`,
      NO_DATABASE,
    )
  } else if (news.length > 0) {
    lines.push(`${news.length} clause(s) have no passing test. That is news, not a schedule.`)
  } else if (scheduled.length > 0) {
    lines.push(
      `Everything built for M6 passes. ${scheduled.length} clause(s) wait on a later row:`,
      ...scheduled.map((clause) => `  - ${clause.criterion}: ${clause.what} (${clause.waitingOn})`),
      "",
      "So the M6 row stays blocked rather than done, by its own bar.",
    )
  } else {
    lines.push("All three criteria pass.")
  }
  return lines.join("\n")
}

if (import.meta.main) {
  const { results, output } = runSuite(FILES, root, "m6")

  if (results.size === 0) {
    console.error("No test results were read. The suite did not run:\n")
    console.error(output.slice(-2000))
    process.exit(1)
  }

  const clauses = checkClauses(results)
  console.log(format(clauses, results.size))
  // A clause waiting on a later row or on the builder is not a surprise,
  // so it does not fail the command. What fails it is a clause that should
  // have a passing test and does not, and a clause whose test did not run
  // at all, which means this check proved nothing.
  const unproven = clauses.filter(
    (clause) => !clause.pass && (clause.state === "skip" || clause.waitingOn === undefined),
  )
  process.exit(unproven.length === 0 ? 0 : 1)
}
