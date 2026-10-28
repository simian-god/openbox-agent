// The M7 check, from Plan.md: "C10, C16 and C17 pass, and a dependency
// that never answers ends the turn, answers the person and lets `stop()`
// finish."
//
// Same shape as m4-check and m6-check, and for the same reason: every
// clause is a claim about behaviour, and behaviour is what the suite
// already asserts. This names the test that proves each clause, runs those
// files, and fails if a clause has no passing test behind it. A check that
// asserted the same things a second time would be a second implementation
// to keep in step, and the first time they disagreed nobody would know
// which to believe.
//
// One clause is expected to wait, and says so rather than being quietly
// left out: C17 opens with "a voice note in Hindi or Hinglish". Everything
// the core does with a voice note is proven here, on an injected
// transcriber. Whether a real one renders Hinglish is Known K21 and needs
// the builder's own audio, so that half waits.
//
// `readResults` is borrowed from m6-check rather than copied. There are
// already two copies of it between m4 and m6; a third would be worse than
// an odd import. When a fourth check wants it, it should move to a shared
// module and all of them should use that.
//
// Usage: bun run m7-check
import { spawnSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readResults } from "./m6-check.ts"

const root = join(import.meta.dir, "..")

/** The files that hold M7's proof. */
const FILES = [
  "packages/core/test/integration/limits.test.ts",
  "packages/core/test/integration/proactive.test.ts",
  "packages/core/test/integration/sendrules.test.ts",
  "packages/core/test/integration/voice.test.ts",
  "packages/core/test/integration/deadlines.test.ts",
]

interface Clause {
  criterion: "C10" | "C16" | "C17" | "M7"
  /** The clause, in the Intent's own words where it has them. */
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
  // C10: "A flood of messages hits the rate limit and gets the fixed
  // reply. No turn exceeds the step cap. Crossing the spend cap switches
  // the agent to handover only."
  {
    criterion: "C10",
    what: "a flood hits the rate limit and gets the fixed reply",
    test: "LIMIT-1: over the limit the person gets one fixed reply, and it costs nothing",
  },
  {
    criterion: "C10",
    what: "and then silence, rather than that reply to every message",
    test: "LIMIT-1: the next message in the same window gets silence",
  },
  {
    criterion: "C10",
    what: "an operator is never rate limited, since resume arrives on their channel",
    test: "LIMIT-1: an operator is not rate limited",
  },
  {
    criterion: "C10",
    what: "no turn exceeds the step cap, and the person is told when one would",
    test: "LIMIT-2 and LOOP-9: the step cap tells the person, flags the turn and hands over",
  },
  {
    criterion: "C10",
    what: "crossing the spend cap switches the agent to handover only",
    test: "LIMIT-3: at the cap, the next turn is a handover and costs nothing",
  },

  // C16: "A scheduled reminder survives a restart and sends exactly once.
  // On WhatsApp outside the window, only a template goes out. Nothing non
  // urgent goes out in quiet hours. After STOP, nothing goes out until the
  // person opts back in."
  {
    criterion: "C16",
    what: "a scheduled reminder survives a restart",
    test: "PRO-1: a scheduled message survives a restart",
  },
  {
    criterion: "C16",
    what: "and sends exactly once, however often the job is taken over",
    test: "PRO-1: a job that runs twice sends once",
  },
  {
    criterion: "C16",
    what: "outside the window, free text does not go out",
    test: "PRO-3: outside the window, free text fails and is flagged",
  },
  {
    criterion: "C16",
    what: "outside the window, a template does",
    test: "PRO-3: outside the window, a template goes out",
  },
  {
    criterion: "C16",
    what: "and a triggered event reaches somebody out there, with no brain call (PRO-5)",
    test: "PRO-5 and PRO-3: a triggered event reaches somebody outside the window",
  },
  {
    criterion: "C16",
    what: "nothing non urgent goes out in quiet hours",
    test: "PRO-3: a non urgent message in quiet hours waits until they end",
  },
  {
    criterion: "C16",
    what: "an urgent one still does",
    test: "PRO-3: an urgent message goes out in quiet hours",
  },
  {
    criterion: "C16",
    what: "after STOP nothing goes out until the person opts back in",
    test: "C16: after STOP nothing goes out, and after START it does",
  },

  // C17: "A voice note in Hindi or Hinglish is transcribed and answered in
  // the same language. An image sent to a text only brain gets the
  // fallback reply. A tool can send a PDF."
  {
    criterion: "C17",
    what: "a voice note is transcribed, and the transcript is what the brain is asked about",
    test: "LOOP-6 and MEDIA-1: the brain is asked about the words, not a voice note",
  },
  {
    criterion: "C17",
    what: "the language it was spoken in is stored on the person",
    test: "MEDIA-3: the language is stored on the person",
  },
  {
    criterion: "C17",
    what: "and the brain is told to answer in it, on that turn rather than the next",
    test: "MEDIA-3: the brain is told to answer in that language",
  },
  {
    criterion: "C17",
    what: "a voice note nobody could hear asks the person to type, without losing the turn",
    test: "MEDIA-1: when the transcriber fails, and the trace says why",
  },
  {
    criterion: "C17",
    what: "the same, on real Hindi or Hinglish audio through a real transcriber",
    test: "live: a Hinglish voice note is transcribed and answered in the same language",
    waitingOn: "Known K21: the builder's own voice notes, and a SARVAM_API_KEY to compare",
  },
  {
    criterion: "C17",
    what: "an image sent to a text only brain gets the fallback reply",
    test: "MEDIA-2: and the person is told so, with the caption still answered",
  },
  {
    criterion: "C17",
    what: "and its caption is still answered, so the turn is not wasted",
    test: "MEDIA-2: a brain that cannot is told nothing about the picture",
  },
  {
    criterion: "C17",
    what: "a tool can send a PDF, through the outbox",
    test: "MEDIA-4: the file goes out through the outbox, with its caption",
  },
  {
    criterion: "C17",
    what: "and cannot on a channel that carries no files",
    test: "MEDIA-4: it is refused when the channel cannot carry files",
  },

  // M7's own clause: "a dependency that never answers ends the turn,
  // answers the person and lets `stop()` finish."
  {
    criterion: "M7",
    what: "a brain that never answers ends the turn rather than holding it",
    test: "LOOP-12: a turn whose only brain hangs ends, rather than hanging with it",
  },
  {
    criterion: "M7",
    what: "and is cancelled, not abandoned mid flight",
    test: "BRAIN-6: it is given up on, and the request is cancelled",
  },
  {
    criterion: "M7",
    what: "a tool that never answers ends the step, and the brain is told in words it can use",
    test: "LOOP-10: the turn stops waiting and the brain is told, in words it can use",
  },
  {
    criterion: "M7",
    what: "the person is answered either way, rather than left with nothing",
    test: "LOOP-12: every brain failing tells the person and alerts an operator",
  },
  {
    criterion: "M7",
    what: "and stop() finishes, rather than waiting on the turn for ever",
    test: "K3: stop() returns rather than waiting for ever",
  },
]

interface ClauseResult extends Clause {
  pass: boolean
  detail: string
}

export function checkClauses(results: Map<string, boolean>): ClauseResult[] {
  return CLAUSES.map((clause) => {
    const matching = [...results.entries()].filter(([name]) => name.includes(clause.test))

    if (matching.length === 0) {
      return {
        ...clause,
        pass: false,
        detail:
          clause.waitingOn === undefined
            ? `no test named "${clause.test}". It was renamed or removed.`
            : `not proven yet: waiting on ${clause.waitingOn}`,
      }
    }

    const failed = matching.filter(([, passed]) => !passed).map(([name]) => name)
    return failed.length === 0
      ? { ...clause, pass: true, detail: matching[0]?.[0] ?? clause.test }
      : { ...clause, pass: false, detail: `failing: ${failed.join("; ")}` }
  })
}

export function format(clauses: ClauseResult[], ran: number): string {
  const lines = ["", "================ M7 check ================", ""]
  lines.push(`${ran} tests ran across ${FILES.length} files, on the scripted brain,`)
  lines.push("the scripted decision model and an injected transcriber. No keys, no network.")

  for (const criterion of ["C10", "C16", "C17", "M7"] as const) {
    const mine = clauses.filter((clause) => clause.criterion === criterion)
    const ok = mine.every((clause) => clause.pass)
    const scheduled = mine.filter((clause) => !clause.pass && clause.waitingOn !== undefined)
    const news = mine.filter((clause) => !clause.pass && clause.waitingOn === undefined)

    const verdict = ok
      ? "PASS"
      : news.length > 0
        ? "FAIL"
        : `PART  (${scheduled.length} clause(s) not proven yet)`
    const label = criterion === "M7" ? "M7's own clause" : criterion
    lines.push("", `${verdict}  ${label}`)
    for (const clause of mine) {
      const mark = clause.pass ? "ok  " : clause.waitingOn === undefined ? "FAIL" : "wait"
      lines.push(`      ${mark} ${clause.what}`)
      if (!clause.pass) lines.push(`           ${clause.detail}`)
    }
  }

  const news = clauses.filter((clause) => !clause.pass && clause.waitingOn === undefined)
  const scheduled = clauses.filter((clause) => !clause.pass && clause.waitingOn !== undefined)

  lines.push("")
  if (news.length > 0) {
    lines.push(`${news.length} clause(s) have no passing test. That is news, not a schedule.`)
  } else if (scheduled.length > 0) {
    lines.push(
      `Everything the core can prove on its own passes. ${scheduled.length} clause(s) wait:`,
      ...scheduled.map((clause) => `  - ${clause.criterion}: ${clause.what} (${clause.waitingOn})`),
      "",
      "So the M7 row stays blocked rather than done, by its own bar.",
    )
  } else {
    lines.push("All of M7's bar passes.")
  }
  return lines.join("\n")
}

if (import.meta.main) {
  const report = join(tmpdir(), `openbox-m7-${process.pid}.xml`)
  const run = spawnSync(
    "bun",
    ["test", ...FILES, "--reporter=junit", `--reporter-outfile=${report}`],
    { cwd: root, encoding: "utf8", shell: true, env: { ...process.env, OPENBOX_LIVE: "" } },
  )
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`

  let results = new Map<string, boolean>()
  try {
    results = readResults(readFileSync(report, "utf8"))
  } catch {
    // Falls through to the error below, which prints what the suite said.
  } finally {
    rmSync(report, { force: true })
  }

  if (results.size === 0) {
    console.error("No test results were read. The suite did not run:\n")
    console.error(output.slice(-2000))
    process.exit(1)
  }

  const clauses = checkClauses(results)
  console.log(format(clauses, results.size))
  // A clause waiting on the builder is not a surprise, so it does not fail
  // the command: what fails it is a clause that should have a passing test
  // and does not.
  const news = clauses.filter((clause) => !clause.pass && clause.waitingOn === undefined)
  process.exit(news.length === 0 ? 0 : 1)
}
