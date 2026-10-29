// The milestone checks read the suite's own results rather than asserting
// behaviour a second time, so how they read those results is load bearing:
// a check that misreads them reports a green milestone on a suite that
// never ran.
//
// This file exists because that happened. The first version treated "no
// failure element" as a pass, and a skipped test has no failure element,
// so with no database running every integration test skipped and m4, m6
// and m7 all reported PASS on a suite that proved nothing.
import { test, expect, describe } from "bun:test"
import { describeClause, matchClause, readResults } from "../../../../scripts/support/results.ts"

/** A junit report, in the shape Bun's reporter writes. */
function report(cases: { name: string; body?: string }[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="bun test">',
    '  <testsuite name="f.test.ts">',
    ...cases.map(({ name, body }) =>
      body === undefined
        ? `    <testcase name="${name}" classname="c" />`
        : `    <testcase name="${name}" classname="c">${body}</testcase>`,
    ),
    "  </testsuite>",
    "</testsuites>",
  ].join("\n")
}

describe("reading the suite's results", () => {
  test("a test that passed is a pass", () => {
    expect(readResults(report([{ name: "KNOW-3: it searches" }]))).toEqual(
      new Map([["KNOW-3: it searches", "pass"]]),
    )
  })

  test("a test that failed is a fail", () => {
    const xml = report([{ name: "a", body: "<failure message='no'/>" }])
    expect(readResults(xml).get("a")).toBe("fail")
  })

  test("a test that errored is a fail", () => {
    const xml = report([{ name: "a", body: "<error message='boom'/>" }])
    expect(readResults(xml).get("a")).toBe("fail")
  })

  // The bug. A skipped test carries no failure element, so anything that
  // asks only "did it fail" calls it a pass.
  test("a test that was skipped is not a pass", () => {
    const xml = report([{ name: "a", body: "<skipped />" }])
    expect(readResults(xml).get("a")).toBe("skip")
  })

  test("the same name twice is as bad as its worst run", () => {
    const xml = report([
      { name: "a" },
      { name: "a", body: "<failure message='no'/>" },
      { name: "b" },
      { name: "b", body: "<skipped />" },
    ])
    expect(readResults(xml).get("a")).toBe("fail")
    expect(readResults(xml).get("b")).toBe("skip")
  })

  test("names come back unescaped, since a clause names the test in plain text", () => {
    const xml = report([{ name: "CONF-4: a colleague&apos;s &quot;yes&quot; &lt;ok&gt;" }])
    expect([...readResults(xml).keys()]).toEqual(['CONF-4: a colleague\'s "yes" <ok>'])
  })

  test("a report with no test cases in it reads as nothing, not as everything passing", () => {
    expect(readResults("<testsuites />").size).toBe(0)
  })
})

describe("matching a clause to the test that proves it", () => {
  const results = readResults(
    report([
      { name: "KNOW-3: the source comes back" },
      { name: "KNOW-4: ranked by the database" },
      { name: "KNOW-2: added live", body: "<failure message='no'/>" },
      { name: "DATA-1: another agent", body: "<skipped />" },
    ]),
  )

  test("a passing test proves the clause", () => {
    const found = matchClause(results, "KNOW-3: the source comes back")
    expect(found.state).toBe("pass")
    expect(found.names).toEqual(["KNOW-3: the source comes back"])
  })

  test("part of the name is enough, so a clause need not repeat it whole", () => {
    expect(matchClause(results, "ranked by the database").state).toBe("pass")
  })

  test("a failing test fails the clause", () => {
    expect(matchClause(results, "KNOW-2: added live").state).toBe("fail")
  })

  // The point of the whole file: a milestone cannot pass on a test that
  // did not run.
  test("a skipped test leaves the clause unproven rather than proven", () => {
    expect(matchClause(results, "DATA-1: another agent").state).toBe("skip")
  })

  test("a name nothing matches is missing, which means it was renamed or removed", () => {
    expect(matchClause(results, "KNOW-9: something nobody wrote").state).toBe("missing")
  })

  test("one clause matching several tests is as bad as the worst of them", () => {
    const many = readResults(
      report([
        { name: "GATE-1: a" },
        { name: "GATE-1: b", body: "<skipped />" },
        { name: "GATE-1: c", body: "<failure message='no'/>" },
      ]),
    )
    expect(matchClause(many, "GATE-1:").state).toBe("fail")
    expect(matchClause(many, "GATE-1:").names).toHaveLength(3)

    const skipped = readResults(
      report([{ name: "GATE-1: a" }, { name: "GATE-1: b", body: "<skipped />" }]),
    )
    expect(matchClause(skipped, "GATE-1:").state).toBe("skip")
  })
})

describe("the words a check prints under a clause", () => {
  const results = readResults(
    report([
      { name: "KNOW-3: the source comes back" },
      { name: "KNOW-2: added live", body: "<failure message='no'/>" },
      { name: "DATA-1: another agent", body: "<skipped />" },
    ]),
  )

  test("a passing clause names the test that proved it", () => {
    const said = describeClause(results, "KNOW-3: the source")
    expect(said.pass).toBe(true)
    expect(said.detail).toBe("KNOW-3: the source comes back")
  })

  test("a missing test is reported as renamed or removed", () => {
    const said = describeClause(results, "nobody wrote this")
    expect(said.pass).toBe(false)
    expect(said.detail).toContain("renamed or removed")
  })

  test("a clause waiting on a later row says what it waits on, not that it vanished", () => {
    const said = describeClause(results, "nobody wrote this", "T11.2")
    expect(said.pass).toBe(false)
    expect(said.detail).toBe("not proven yet: waiting on T11.2")
    expect(said.detail).not.toContain("removed")
  })

  // A clause that waits on a later row is a schedule. A clause whose test
  // exists and did not run is a machine with no database, which is a
  // different problem and must not borrow the scheduled wording.
  test("waiting on a later row never excuses a test that was skipped", () => {
    const said = describeClause(results, "DATA-1: another agent", "T11.2")
    expect(said.state).toBe("skip")
    expect(said.pass).toBe(false)
    expect(said.detail).toContain("did not run")
  })

  test("a failing clause names what failed", () => {
    const said = describeClause(results, "KNOW-2: added live")
    expect(said.pass).toBe(false)
    expect(said.detail).toContain("failing: KNOW-2: added live")
  })
})
