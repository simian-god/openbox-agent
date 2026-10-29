// What the milestone checks have in common: running part of the suite and
// reading back which tests passed.
//
// Every check works the same way, for the same reason. A clause of the bar
// is a claim about behaviour, and behaviour is what the suite already
// asserts, so a check names the test that proves each clause and fails if
// a clause has no passing test behind it. Asserting the same things a
// second time would be a second implementation to keep in step, and the
// first time the two disagreed nobody would know which to believe.
//
// This lives here because m7-check's note said it should: there were two
// copies of the reader between m4 and m6, m7 borrowed m6's, and the note
// said the fourth check should move it somewhere shared and have all of
// them use it. m8 is the fourth.
//
// Moving it found a bug in it. The reader used to call a test passed when
// its entry held no `<failure>` or `<error>` element, and a **skipped**
// test holds neither. Integration tests skip when no database is running,
// so on a machine without Docker every clause of m4, m6 and m7 matched a
// skipped test and all three printed PASS, having proven nothing. A check
// that cannot tell "proved" from "never ran" is worse than no check: the
// one thing it is for is being believed. So the reader is three valued
// now, and a skipped test leaves its clause unproven.
import { spawnSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** What the suite did with one test. */
export type Outcome = "pass" | "fail" | "skip"

/** What the suite says about one clause of a milestone's bar. */
export type ClauseState =
  | "pass"
  /** A test proves it, and it failed. */
  | "fail"
  /** A test proves it, and it did not run. Usually no database. */
  | "skip"
  /** Nothing is named that. It was renamed or removed. */
  | "missing"

/** Worse wins, so a name that ran twice is judged by its worse run. */
function worse(left: Outcome, right: Outcome): Outcome {
  if (left === "fail" || right === "fail") return "fail"
  if (left === "skip" || right === "skip") return "skip"
  return "pass"
}

/** Every test in a Bun junit report, by name. */
export function readResults(xml: string): Map<string, Outcome> {
  const found = new Map<string, Outcome>()

  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = match[1] ?? ""
    const body = match[3] ?? ""
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1]
    if (name === undefined) continue

    const outcome: Outcome = /<(failure|error)\b/.test(body)
      ? "fail"
      : /<skipped\b/.test(body)
        ? "skip"
        : "pass"

    const plain = unescapeXml(name)
    const already = found.get(plain)
    found.set(plain, already === undefined ? outcome : worse(already, outcome))
  }
  return found
}

function unescapeXml(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

/**
 * What the suite says about the clause whose proof is named `test`.
 *
 * Part of a name is enough, so a clause can name the test it relies on
 * without repeating every word of it. Several matches are judged by the
 * worst one: a clause resting on four tests is not proven when one of
 * them failed.
 */
export function matchClause(
  results: Map<string, Outcome>,
  test: string,
): { state: ClauseState; names: string[] } {
  const names = [...results.keys()].filter((name) => name.includes(test))
  if (names.length === 0) return { state: "missing", names: [] }

  const outcome = names
    .map((name) => results.get(name) ?? "fail")
    .reduce((left, right) => worse(left, right))
  return { state: outcome, names }
}

/** What a check says about one clause of its bar. */
export interface ClauseVerdict {
  state: ClauseState
  pass: boolean
  /** Why, in the words the check prints under the clause. */
  detail: string
}

/**
 * The verdict on one clause, and the wording that goes with it.
 *
 * `waitingOn` is for a clause whose proof is a later row or something only
 * the builder can do. Such a clause still does not pass: it is named so
 * the report says which failures are scheduled and which are news.
 */
export function describeClause(
  results: Map<string, Outcome>,
  test: string,
  waitingOn?: string,
): ClauseVerdict {
  const { state, names } = matchClause(results, test)

  if (state === "pass") return { state, pass: true, detail: names[0] ?? test }
  if (state === "skip") return { state, pass: false, detail: `did not run: ${names.join("; ")}` }
  if (state === "fail") return { state, pass: false, detail: `failing: ${names.join("; ")}` }
  return {
    state,
    pass: false,
    detail:
      waitingOn === undefined
        ? `no test named "${test}". It was renamed or removed.`
        : `not proven yet: waiting on ${waitingOn}`,
  }
}

/**
 * Runs these test files and reads the results back.
 *
 * Read from the JUnit report rather than the console, because `bun test`
 * prints only the failures by default: a check that read the console would
 * see nothing at all on a clean run, which is exactly when it has to work.
 */
export function runSuite(
  files: string[],
  root: string,
  label: string,
): { results: Map<string, Outcome>; output: string } {
  const report = join(tmpdir(), `openbox-${label}-${process.pid}.xml`)
  const run = spawnSync(
    "bun",
    ["test", ...files, "--reporter=junit", `--reporter-outfile=${report}`],
    { cwd: root, encoding: "utf8", shell: true, env: { ...process.env, OPENBOX_LIVE: "" } },
  )
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`

  let results = new Map<string, Outcome>()
  try {
    results = readResults(readFileSync(report, "utf8"))
  } catch {
    // Left empty on purpose. The caller reports that the suite did not run
    // and prints `output`, which says why.
  } finally {
    rmSync(report, { force: true })
  }
  return { results, output }
}

/**
 * The line every check prints when its clauses rest on skipped tests.
 *
 * One line rather than one per clause, because the cause is always the
 * same and the fix always is too.
 */
export const NO_DATABASE =
  "Those tests did not run. Integration tests need the local database:\n" +
  "  bun run db:up   (then run this check again)"
