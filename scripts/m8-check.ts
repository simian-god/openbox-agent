// The M8 check, from Plan.md: "C18 passes on the `local` retriever.
// pgvector passes on Postgres; under evals-agent it waits for sqlite-vec
// support."
//
// C18 is the Intent's eighteenth criterion: "Questions answerable only
// from a knowledge file get correct answers with both retrievers."
//
// Same shape as m4, m6 and m7, and for the same reason: a clause of the
// bar is a claim about behaviour, and behaviour is what the suite already
// asserts. This names the test that proves each clause, runs those files,
// and fails if a clause has no passing test behind it. Asserting the same
// things a second time would be a second implementation to keep in step,
// and the first time the two disagreed nobody would know which to believe.
//
// Being the fourth check, this is the one that moved the shared reading of
// results into `scripts/support/results.ts`, as m7-check's note asked.
// That move found a bug worth knowing about here: the old reader counted a
// skipped test as a pass, so on a machine with no database every clause of
// m4, m6 and m7 matched a skipped test and all three printed PASS having
// proven nothing. This check would have done the same. A skipped clause
// now reads UNRUN and fails the command.
//
// What C18 means here, and what it does not. "Correct answer" is checked
// as the core can check it: the chunk out of the right file reaches the
// brain with its source, and the reply reaches the person. Every milestone
// check runs on the scripted brain, so how a real model words that answer
// is not what is being proven, and the embedder is a stub throughout
// (Known K29). What is proven is that the right chunk, and only the right
// chunk, is what an answer could have come from.
//
// Usage: bun run m8-check
import { join } from "node:path"
import {
  type ClauseState,
  type Outcome,
  describeClause,
  NO_DATABASE,
  runSuite,
} from "./support/results.ts"

const root = join(import.meta.dir, "..")

/** The files that hold M8's proof. */
const FILES = [
  "packages/core/test/unit/knowledge.test.ts",
  "packages/core/test/unit/retriever.test.ts",
  "packages/core/test/integration/knowledge.test.ts",
  "packages/core/test/integration/pgvector.test.ts",
]

interface Clause {
  /**
   * Which half of the bar. `local` and `pgvector` are C18 on each
   * retriever, and `evals` is the bar's own last clause.
   */
  part: "local" | "pgvector" | "evals"
  /** The clause, in the bar's own words where it has them. */
  what: string
  /** Part of the name of a test that proves it. */
  test: string
  /**
   * Why this clause cannot pass yet, and what would fix it. A clause with
   * this set still does not pass: it is here so the report says which
   * failures are scheduled and which are news.
   */
  waitingOn?: string
}

const CLAUSES: Clause[] = [
  // C18 on `local`. Keyword ranking in process, which is the default
  // every agent gets without configuring anything.
  {
    part: "local",
    what: "every file in the knowledge folder is loaded",
    test: "KNOW-1: every file in knowledge/ is loaded",
  },
  {
    part: "local",
    what: "and split so the heading is searchable, which is usually the line that matches",
    test: "KNOW-1: the heading is part of the chunk",
  },
  {
    part: "local",
    what: "a question finds the chunk that answers it",
    test: "KNOW-4: a question finds the chunk that answers it",
  },
  {
    part: "local",
    what: "and the chunk says which file it came from",
    test: "KNOW-3: the source comes back with the text",
  },
  {
    part: "local",
    what: "the answer is only in the file: with no documents the same search finds nothing",
    test: "KNOW-1: an agent with no documents searches nothing, rather than failing",
  },
  {
    part: "local",
    what: "asked through the agent, the chunk reaches the brain with its source",
    test: "KNOW-1 and KNOW-3: a document passed in is searchable, and says where it came from",
  },
  {
    part: "local",
    what: "and the answer reaches the person, which is what the criterion is about",
    test: "C18: the answer out of the file reaches the person, on local",
  },
  {
    part: "local",
    what: "nothing found tells the brain to say so rather than inventing an answer",
    test: "KNOW-3: nothing found tells the brain to say so rather than inventing",
  },
  {
    part: "local",
    what: "no more than knowledgeResults chunks are handed over",
    test: "KNOW-3: no more than knowledgeResults come back",
  },
  {
    part: "local",
    what: "and it really was the in process retriever, by its own name on the event",
    test: "EVT-2: a search is recorded, with how much it found",
  },

  // C18 on pgvector, which ranks in the database. "Passes on Postgres"
  // takes in the optional migration, because without it the retriever has
  // no table to rank in.
  {
    part: "pgvector",
    what: "the table exists once its optional migration is run",
    test: "DATA-3: the optional migration creates the table and records itself",
  },
  {
    part: "pgvector",
    what: "and the core schema does not carry it, so nobody pays for pgvector unasked",
    test: "DATA-3: the core schema does not carry the pgvector table",
  },
  {
    part: "pgvector",
    what: "with row level security on it, like every other table (DATA-5)",
    test: "DATA-5: the optional table has row level security switched on",
  },
  {
    part: "pgvector",
    what: "a chunk and its embedding are stored in that table",
    test: "KNOW-4: the chunk and its embedding are stored in the optional table",
  },
  {
    part: "pgvector",
    what: "the nearest chunk comes back first, ranked by the database",
    test: "KNOW-4: the nearest chunk comes back first, ranked by the database",
  },
  {
    part: "pgvector",
    what: "with its text and the file it came from",
    test: "KNOW-3: the text and the source come back with the score",
  },
  {
    part: "pgvector",
    what: "no more than k come back, and the k kept are the best ones",
    test: "KNOW-3: no more than k come back, and the k kept are the best ones",
  },
  {
    part: "pgvector",
    what: "one agent never reads the chunks of another (DATA-1)",
    test: "DATA-1: a search never returns another agent",
  },
  {
    part: "pgvector",
    what: "nothing to find returns nothing rather than failing",
    test: "KNOW-4: searching an empty table returns nothing rather than failing",
  },
  {
    part: "pgvector",
    what: "asked through the agent, the chunk reaches the brain with its source",
    test: "C18: the chunk reaches the brain, with the file it came from",
  },
  {
    part: "pgvector",
    what: "and the answer reaches the person, which is what the criterion is about",
    test: "C18: the answer out of the file reaches the person, on pgvector",
  },
  {
    part: "pgvector",
    what: "and the documents really went to Postgres, not to an index in memory",
    test: "C18: the documents really went to Postgres, not to an index in memory",
  },
  {
    part: "pgvector",
    what: "a builder who forgets the migration is told to run it, not shown a missing relation",
    test: "DATA-3: an agent configured for pgvector without the migration is told to run it",
  },

  // The bar's own last clause, which says in its own words that it waits.
  {
    part: "evals",
    what: "the same questions answered under evals-agent, on its own vector search",
    test: "nothing in this repo proves this",
    waitingOn:
      "sqlite-vec support in evals-agent (Spec section 23, Known K29). evals-agent is not a " +
      "dependency of this repo, so nothing here can run it, and this retriever is Postgres " +
      "SQL that a SQLite world cannot run whatever is added to it",
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

const TITLES: Record<Clause["part"], string> = {
  local: "C18 on the `local` retriever, in process",
  pgvector: "C18 on pgvector, ranked in the database",
  evals: "the last clause of the bar: under evals-agent",
}

export function format(clauses: ClauseResult[], ran: number): string {
  const lines = ["", "================ M8 check ================", ""]
  lines.push(`${ran} tests ran across ${FILES.length} files, on the scripted brain,`)
  lines.push("the scripted decision model and a stub embedder. No keys, no network.")

  for (const part of ["local", "pgvector", "evals"] as const) {
    const mine = clauses.filter((clause) => clause.part === part)
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
  } else {
    lines.push("Both retrievers answer a question that only a knowledge file answers.")
    for (const clause of scheduled) {
      lines.push("", `One clause waits, which the bar itself says it does: ${clause.what}.`)
      lines.push(`  ${clause.waitingOn ?? ""}`)
    }
  }
  return lines.join("\n")
}

if (import.meta.main) {
  const { results, output } = runSuite(FILES, root, "m8")

  if (results.size === 0) {
    console.error("No test results were read. The suite did not run:\n")
    console.error(output.slice(-2000))
    process.exit(1)
  }

  const clauses = checkClauses(results)
  console.log(format(clauses, results.size))
  // A clause the bar itself says waits is not a surprise, so it does not
  // fail the command. What fails it is a clause that should have a passing
  // test and does not, and a clause whose test did not run at all, which
  // means this check proved nothing.
  //
  // The skip half of that is insurance today rather than load bearing:
  // every clause that can be skipped is also a clause with no `waitingOn`,
  // so the second test already catches it. What it guards is a waiting
  // clause whose test exists and is skipped, where the schedule would
  // otherwise swallow a machine with no database. `describeClause` has a
  // test for exactly that, so the path is not untested insurance.
  const unproven = clauses.filter(
    (clause) => !clause.pass && (clause.state === "skip" || clause.waitingOn === undefined),
  )
  process.exit(unproven.length === 0 ? 0 : 1)
}
