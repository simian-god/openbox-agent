// Tests for scripts/trace.ts, the Spec ID coverage report.
//
// Two rules keep this file out of its own report. The script reads this file
// like any other, so anything here that looks like a test naming a Spec ID
// would mark that requirement proven without proving anything.
//
//   1. No test title here contains the ID shape (LETTERS-number).
//   2. Fixture test calls are built by `testCall`, never written out in full,
//      so no line here spells out a call whose title holds an ID.
import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  specRequirements,
  idsNamedInTests,
  trace,
  formatReport,
} from "../../../../scripts/trace.ts"

const spec = (...lines: string[]) => lines.join("\n")

/** Source text for a test call, assembled so this file is not itself scanned as one. */
function testCall(title: string, options: { fn?: string; quote?: '"' | "`" } = {}): string {
  const fn = options.fn ?? "test"
  const quote = options.quote ?? '"'
  return [fn, "(", quote, title, quote, ", () => {})"].join("")
}

test("trace: reads every requirement the Spec declares, with its section", () => {
  const markdown = spec(
    "# Spec",
    "",
    "## 4. Injected dependencies",
    "",
    "**DEP-1.** The core reaches the outside world only through these.",
    "",
    "**DEP-2.** Transcribers at launch.",
    "",
    "## 9. Confirmation",
    "",
    "**CONF-1.** Some actions need a yes.",
  )

  expect(specRequirements(markdown)).toEqual([
    { id: "DEP-1", section: "4. Injected dependencies" },
    { id: "DEP-2", section: "4. Injected dependencies" },
    { id: "CONF-1", section: "9. Confirmation" },
  ])
})

test("trace: counts an ID only where the Spec declares it, not where it is mentioned", () => {
  const markdown = spec(
    "## 9. Confirmation",
    "",
    "**CONF-1.** Confirmation is required, and this restates CONF-4 and GATE-2.",
    "",
    "Prose referring to CONF-9 does not declare it.",
  )

  expect(specRequirements(markdown).map((r) => r.id)).toEqual(["CONF-1"])
})

test("trace: a requirement is covered when a test title names it", () => {
  const sources = [
    testCall("CONF-4: rejects a confirm from another person"),
    testCall("DEP-1: no fetch outside providers", { fn: "it", quote: "`" }),
    testCall("GATE-2: fails closed", { fn: "test.skip" }),
  ]

  const named = idsNamedInTests(sources)
  expect([...named].sort()).toEqual(["CONF-4", "DEP-1", "GATE-2"])
})

test("trace: an ID in ordinary code is not mistaken for a test title", () => {
  const sources = ['const message = "CONF-4 happened"', "// TOOL-1 is handled elsewhere"]

  expect([...idsNamedInTests(sources)]).toEqual([])
})

test("trace: splits requirements into covered and uncovered", () => {
  const markdown = spec(
    "## 4. Injected dependencies",
    "",
    "**DEP-1.** First.",
    "",
    "**DEP-2.** Second.",
  )
  const report = trace(markdown, [testCall("DEP-1: proven")])

  expect(report.covered.map((r) => r.id)).toEqual(["DEP-1"])
  expect(report.uncovered.map((r) => r.id)).toEqual(["DEP-2"])
  expect(report.unknown).toEqual([])
})

test("trace: flags a test naming an ID the Spec does not declare", () => {
  const report = trace(spec("## 4. Deps", "", "**DEP-1.** First."), [
    testCall("DEP-7: a stale or mistyped name"),
  ])

  expect(report.unknown).toEqual(["DEP-7"])
})

test("trace: the report states the counts and lists what is missing", () => {
  const markdown = spec("## 4. Deps", "", "**DEP-1.** First.", "", "**DEP-2.** Second.")
  const text = formatReport(trace(markdown, [testCall("DEP-1: proven")]), false)

  expect(text).toContain("covered    1 / 2  (50%)")
  expect(text).toContain("uncovered  1")
  expect(text).toContain("DEP-2")
  expect(text).not.toContain("DEP-1\n")
})

test("trace: the real Spec still parses, so a format change cannot go unnoticed", () => {
  const markdown = readFileSync(
    join(import.meta.dir, "..", "..", "..", "..", "docs", "Spec.md"),
    "utf8",
  )
  const requirements = specRequirements(markdown)

  // A floor, not an exact count: the Spec gains requirements over time.
  expect(requirements.length).toBeGreaterThan(100)
  for (const requirement of requirements) {
    expect(requirement.id).toMatch(/^[A-Z][A-Z0-9]*-\d+$/)
    expect(requirement.section).not.toBe("(no section)")
  }
  // Every ID is unique.
  expect(new Set(requirements.map((r) => r.id)).size).toBe(requirements.length)
})
