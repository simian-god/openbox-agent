// The M4 check, from Plan.md: "C9, C14 and C15 pass with the scripted
// brain and decision model."
//
// All three criteria are claims about behaviour, and behaviour is what the
// suite already asserts. So this does not reimplement them: it names the
// test that proves each clause, runs those files, and fails if any clause
// has no passing test behind it.
//
// Written that way on purpose. A check that asserted the same things a
// second time would be a second implementation to keep in step, and the
// first time they disagreed nobody would know which was right. This one
// can only fail by a clause losing its test, which is the thing worth
// catching.
//
// In the repo rather than run once, like m3-check, because a milestone bar
// is re-read whenever something near it changes.
//
// Usage: bun run m4-check
import { join } from "node:path"
import {
  type ClauseState,
  type Outcome,
  describeClause,
  NO_DATABASE,
  runSuite,
} from "./support/results.ts"

const root = join(import.meta.dir, "..")

/** The files that hold M4's proof. */
const FILES = [
  "packages/core/test/integration/confirm.test.ts",
  "packages/core/test/unit/confirm.test.ts",
  "packages/core/test/integration/tasks.test.ts",
  "packages/core/test/unit/tasks.test.ts",
  "packages/core/test/integration/time.test.ts",
  "packages/core/test/unit/time.test.ts",
  "packages/core/test/integration/facts.test.ts",
]

interface Clause {
  criterion: "C9" | "C14" | "C15"
  /** The clause, in the Intent's own words. */
  what: string
  /** Part of the name of a test that proves it. */
  test: string
}

const CLAUSES: Clause[] = [
  // C9: "an irreversible tool never runs without a valid confirm from the
  // same person: not on 'why do you keep asking, i already told you', not
  // on a confirm from someone else, not after expiry, and not after the
  // details changed."
  {
    criterion: "C9",
    what: "it does not run on the brain's say so, only on a pending action",
    test: "CONF-1: passing the gate creates a pending action, and runs nothing",
  },
  {
    criterion: "C9",
    what: "insisting is not confirming",
    test: "C9: insisting is not confirming",
  },
  {
    criterion: "C9",
    what: "a confirm from someone else does nothing",
    test: "C9: a confirm from someone else does nothing",
  },
  {
    criterion: "C9",
    what: "a stolen payload does not work either",
    test: "C9: a stolen payload does not work, because the person is signed in",
  },
  {
    criterion: "C9",
    what: "nothing runs after expiry",
    test: "C9: nothing runs after expiry",
  },
  {
    criterion: "C9",
    what: "nothing runs after the details changed",
    test: "C9: nothing runs after the details changed",
  },
  {
    criterion: "C9",
    what: "a valid confirm from the same person does run it, once",
    test: "CONF-5: two taps at the same instant run it once",
  },
  {
    criterion: "C9",
    what: "a code works on a channel with no buttons",
    test: "CONF-4: the typed code runs it too, on a channel with no buttons",
  },

  // C14: "a booking spread over five turns, with an unrelated question in
  // the middle, completes with every field correct. An idle task expires."
  {
    criterion: "C14",
    what: "five turns with an interruption, every field correct",
    test: "C14: five turns, an unrelated question in the middle, every field correct",
  },
  {
    criterion: "C14",
    what: "what is missing is recomputed by code on every change",
    test: "BUILTIN-2: update_task fills a field and recomputes what is missing",
  },
  {
    criterion: "C14",
    what: "a field with no value counts as missing, so a task cannot look full",
    test: "BUILTIN-2: an empty string has not been found out",
  },
  {
    criterion: "C14",
    what: "an idle task expires",
    test: "BUILTIN-3: a task nobody touched expires",
  },
  {
    criterion: "C14",
    what: "a change pushes the idle window out",
    test: "BUILTIN-3: a change pushes the window out, so the old job does nothing",
  },

  // C15: "with a frozen clock, 'tomorrow 8pm' resolves correctly across
  // midnight, month end and the agent's timezone. A request outside
  // opening hours is refused by tool code even when the brain tries."
  {
    criterion: "C15",
    what: "tomorrow 8pm, across midnight",
    test: "C15: across midnight, tomorrow is still the next calendar day here",
  },
  {
    criterion: "C15",
    what: "tomorrow 8pm, across month end",
    test: "C15: across month end, tomorrow rolls the month over",
  },
  {
    criterion: "C15",
    what: "the agent's timezone decides, not the server's",
    test: "TIME-1: the same phrase and instant in another timezone is another answer",
  },
  {
    criterion: "C15",
    what: "out of hours is refused by tool code",
    test: "C15: a booking outside opening hours is refused by the tool",
  },
  {
    criterion: "C15",
    what: "refused even when the brain insists",
    test: "C15: the tool refuses even when the brain insists",
  },
]

export interface ClauseResult extends Clause {
  pass: boolean
  state: ClauseState
  detail: string
}

export function checkClauses(results: Map<string, Outcome>): ClauseResult[] {
  return CLAUSES.map((clause) => ({ ...clause, ...describeClause(results, clause.test) }))
}

export function format(clauses: ClauseResult[], ran: number): string {
  const lines = ["", "================ M4 check ================", ""]
  lines.push(`${ran} tests ran across ${FILES.length} files, on the scripted brain`)
  lines.push("and the scripted decision model. No keys, no network.")

  for (const criterion of ["C9", "C14", "C15"] as const) {
    const mine = clauses.filter((clause) => clause.criterion === criterion)
    const ok = mine.every((clause) => clause.pass)
    const unrun = mine.filter((clause) => clause.state === "skip")
    const broken = mine.filter((clause) => !clause.pass && clause.state !== "skip")
    const verdict = ok
      ? "PASS"
      : broken.length > 0
        ? "FAIL"
        : `UNRUN (${unrun.length} of ${mine.length} clause(s) did not run)`
    lines.push("", `${verdict}  ${criterion}`)
    for (const clause of mine) {
      const mark = clause.pass ? "ok  " : clause.state === "skip" ? "skip" : "FAIL"
      lines.push(`      ${mark} ${clause.what}`)
      if (!clause.pass) lines.push(`           ${clause.detail}`)
    }
  }

  const skipped = clauses.filter((clause) => clause.state === "skip")
  const failed = clauses.filter((clause) => !clause.pass && clause.state !== "skip")

  lines.push("")
  if (failed.length === 0 && skipped.length === 0) {
    lines.push("All three criteria pass.")
  } else {
    if (skipped.length > 0) {
      lines.push(`${skipped.length} clause(s) rest on tests that were skipped.`, NO_DATABASE)
    }
    if (failed.length > 0) {
      lines.push(`${failed.length} clause(s) have no passing test.`)
    }
  }
  return lines.join("\n")
}

if (import.meta.main) {
  const { results, output } = runSuite(FILES, root, "m4")

  if (results.size === 0) {
    console.error("No test results were read. The suite did not run:\n")
    console.error(output.slice(-2000))
    process.exit(1)
  }

  const clauses = checkClauses(results)
  console.log(format(clauses, results.size))
  process.exit(clauses.every((clause) => clause.pass) ? 0 : 1)
}
