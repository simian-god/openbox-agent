// LEARN-4 and LEARN-5, without a database.
//
// What is here is the part a wrong answer would be quiet about: which
// cause a flag is grouped under, and whether a reviewed routing decision
// is written in the shape the file takes. Reading flags and marking them
// reviewed need Postgres and are in the integration suite.
//
// The causes are read out of the Spec rather than copied here, the same
// way the skill's lists are, so a Spec edit fails a test instead of
// leaving the grouping behind.
import { test, expect, describe } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CAUSES,
  causeOf,
  groupByCause,
  toolOf,
  type Cause,
  type FlaggedConversation,
} from "../../src/review/index.ts"
import {
  appendRoutingExample,
  parseRoutingJsonl,
  routingLine,
  withRoutingLine,
} from "../../src/tune/examples.ts"
import { FLAG_KINDS, type FlagKind, type FlagRow } from "../../src/store/index.ts"
import { labelFrom } from "../../src/cli/review.ts"

const spec = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "Spec.md"), "utf8")

/** LEARN-4 step 2's own words, as the Spec writes them. */
const specCauses = (() => {
  const at = spec.indexOf("2. groups them by likely cause:")
  expect(at).toBeGreaterThan(-1)
  const line = spec.slice(at, spec.indexOf("\n", at))
  return line
    .slice(line.indexOf(":") + 1)
    .split(/,| or /)
    .map((part) => part.trim())
    .filter((part) => part !== "")
})()

function flag(over: Partial<FlagRow> = {}): FlagRow {
  return {
    id: "flag-1",
    seq: 1,
    agent_id: "restaurant",
    person_id: "person-1",
    turn_id: "turn-1",
    kind: "tool_error",
    detail: {},
    reviewed_at: null,
    review_outcome: null,
    created_at: "2026-10-31T09:00:00.000Z",
    ...over,
  }
}

const conversation = (over: Partial<FlaggedConversation> = {}): FlaggedConversation => ({
  flag: flag(),
  cause: "tool bug",
  why: "because",
  person: null,
  turn: null,
  messages: [],
  toolRuns: [],
  decisions: [],
  alsoFlagged: [],
  ...over,
})

describe("LEARN-4: the cause a flag is grouped under", () => {
  test("LEARN-4: every cause the Spec names is one the code can propose", () => {
    // The Spec's phrase is "conditions too strict or too loose", which is
    // two fixes in one clause, so it is split and both halves have to be
    // reachable.
    expect(specCauses.length).toBeGreaterThanOrEqual(5)
    const missing = specCauses.filter((cause) => {
      const wanted = cause.replace(/^a /, "")
      return !CAUSES.some((known) => known === wanted || known.endsWith(wanted))
    })
    expect(missing).toEqual([])
  })

  test("LEARN-4: every flag kind proposes a cause and says why", () => {
    // Ten kinds, and a kind nobody mapped would otherwise be grouped
    // under whatever the switch happened to fall through to.
    for (const kind of FLAG_KINDS) {
      const proposed = causeOf(flag({ kind: kind as FlagKind }))
      expect(CAUSES).toContain(proposed.cause)
      expect(proposed.why.length).toBeGreaterThan(10)
    }
  })

  test("LEARN-4: the kinds the trace explains are not grouped as unclear", () => {
    const explained: [FlagKind, Cause][] = [
      ["tool_error", "tool bug"],
      ["unknown_tool", "missing tool"],
      ["low_confidence", "wrong routing"],
      ["gate_block", "conditions too strict"],
      ["step_cap", "prompt gap"],
    ]
    for (const [kind, cause] of explained) {
      expect(causeOf(flag({ kind })).cause).toBe(cause)
    }
  })

  test("LEARN-4: a kind the trace cannot explain says unclear rather than guessing", () => {
    // A confident wrong group sends the reviewer at the wrong fix, which
    // is worse than no group at all.
    for (const kind of [
      "frustration",
      "operator",
      "confirmation_rejected",
      "send_blocked",
    ] as const) {
      expect(causeOf(flag({ kind })).cause).toBe("unclear")
    }
  })

  test("LEARN-4: a handover's cause comes from the reason it opened", () => {
    // The flag itself only says "handover". The reason is what separates
    // a prompt with no stop condition from a provider outage.
    const reasons: [string, Cause][] = [
      ["escalate", "missing knowledge"],
      ["gate_block_repeat", "conditions too strict"],
      ["low_confidence_repeat", "wrong routing"],
      ["tool_failed_repeat", "tool bug"],
      ["step_cap", "prompt gap"],
      ["wants_human", "unclear"],
      ["spend_cap", "unclear"],
      ["brains_failed", "unclear"],
    ]
    for (const [reason, cause] of reasons) {
      expect(causeOf(flag({ kind: "handover", detail: { reason } })).cause).toBe(cause)
    }
  })

  test("LEARN-4: the why names the evidence, so a reviewer can disagree with it", () => {
    const failed = causeOf(
      flag({ kind: "tool_error", detail: { tool: "book_table", error: "503" } }),
    )
    expect(failed.why).toContain("book_table")
    expect(failed.why).toContain("503")

    const invented = causeOf(
      flag({ kind: "unknown_tool", detail: { tool: "cancel_table", offered: ["book_table"] } }),
    )
    expect(invented.why).toContain("cancel_table")
    expect(invented.why).toContain("book_table")
  })

  test("LEARN-4: the tool a flag was about is read from its detail", () => {
    expect(toolOf(flag({ detail: { tool: "book_table" } }))).toBe("book_table")
    // Routing records its pick as `choice`, not `tool`.
    expect(toolOf(flag({ kind: "low_confidence", detail: { choice: "look_up" } }))).toBe("look_up")
    expect(toolOf(flag({ detail: {} }))).toBeNull()
    expect(toolOf(flag({ detail: { tool: 7 } }))).toBeNull()
  })
})

describe("LEARN-4: grouping the backlog", () => {
  test("LEARN-4: the biggest group comes first, so the widest fix is read first", () => {
    const groups = groupByCause([
      conversation({ cause: "prompt gap" }),
      conversation({ cause: "tool bug" }),
      conversation({ cause: "tool bug" }),
      conversation({ cause: "tool bug" }),
      conversation({ cause: "wrong routing" }),
      conversation({ cause: "wrong routing" }),
    ])

    expect(groups.map((group) => group.cause)).toEqual(["tool bug", "wrong routing", "prompt gap"])
    expect(groups[0]?.conversations).toHaveLength(3)
  })

  test("LEARN-4: two runs of one backlog read the same way", () => {
    // Ties break in CAUSES order rather than in whatever order the rows
    // came back, so a reviewer comparing two runs is comparing the work.
    const made = [conversation({ cause: "missing tool" }), conversation({ cause: "wrong routing" })]
    expect(groupByCause(made).map((group) => group.cause)).toEqual([
      "wrong routing",
      "missing tool",
    ])
    expect(groupByCause([...made].reverse()).map((group) => group.cause)).toEqual([
      "wrong routing",
      "missing tool",
    ])
  })

  test("LEARN-4: an empty backlog is no groups, not one empty group", () => {
    expect(groupByCause([])).toEqual([])
  })
})

describe("LEARN-5: a reviewed routing decision, appended", () => {
  const tools = ["book_table", "opening_hours"]

  test("LEARN-5: one message on its own is written as text and tool", () => {
    expect(routingLine({ batch: ["table for 4 tonight"], tool: "book_table" })).toBe(
      '{"text":"table for 4 tonight","tool":"book_table"}',
    )
  })

  test("LEARN-5: a tool that depends on the conversation is written as messages and batch", () => {
    const line = routingLine({
      messages: [{ role: "user", text: "are you open sunday" }],
      batch: ["yes", "book me a table"],
      tool: "book_table",
    })
    const parsed = JSON.parse(line) as Record<string, unknown>

    expect(parsed["messages"]).toEqual([{ role: "user", text: "are you open sunday" }])
    expect(parsed["batch"]).toEqual(["yes", "book me a table"])
    expect(parsed["text"]).toBeUndefined()
  })

  test("LEARN-5: a line it writes is a line the parser reads back", () => {
    // The two halves are in one file for exactly this reason: a writer
    // that drifts from the reader produces a labeled set that fails to
    // load the next time anybody tunes.
    const line = routingLine({ batch: ["two please"], tool: "book_table", role: "operator" })
    const { examples, problems } = parseRoutingJsonl(line, "x.jsonl", tools)

    expect(problems).toEqual([])
    expect(examples[0]?.tool).toBe("book_table")
    expect(examples[0]?.role).toBe("operator")
  })

  test("LEARN-5: the same conversation is not labeled twice", () => {
    // Two lines for one conversation is not a parse error, and merging
    // keeps the last. A reviewer could label the same miss three times
    // and move the accuracy number without adding any evidence.
    const text = '{"text":"table for 4 tonight","tool":"book_table"}\n'
    const again = appendRoutingExample(
      text,
      { batch: ["table for 4 tonight"], tool: "opening_hours" },
      tools,
    )

    expect(again.appended).toBe(false)
    expect(again.existing).toContain("book_table")
  })

  test("LEARN-5: a different conversation is appended", () => {
    const text = '{"text":"table for 4 tonight","tool":"book_table"}\n'
    const added = appendRoutingExample(
      text,
      { batch: ["what time do you close"], tool: "opening_hours" },
      tools,
    )

    expect(added.appended).toBe(true)
    expect(withRoutingLine(text, added.line).split("\n").filter(Boolean)).toHaveLength(2)
  })

  test("LEARN-5: appending to an empty file leaves one line and one newline", () => {
    const added = appendRoutingExample("", { batch: ["hello"], tool: "no_tool" }, tools)
    expect(withRoutingLine("", added.line)).toBe(`${added.line}\n`)
    // And a file whose last line has no newline does not gain a joined line.
    expect(withRoutingLine('{"text":"hi","tool":"no_tool"}', added.line)).toContain("}\n{")
  })

  test("LEARN-5: a label naming a tool the agent does not have is refused", () => {
    expect(() => appendRoutingExample("", { batch: ["hi"], tool: "" }, tools)).toThrow()
  })
})

describe("LEARN-5: the label a flagged conversation becomes", () => {
  const message = (over: Record<string, unknown>) => ({
    id: "m",
    seq: 1,
    agent_id: "restaurant",
    person_id: "person-1",
    turn_id: "turn-1",
    direction: "inbound" as const,
    author: "person" as const,
    text: null,
    transcript: null,
    media_ref: null,
    channel: "whatsapp",
    created_at: "2026-10-31T09:00:00.000Z",
    ...over,
  })

  test("LEARN-5: the flagged turn's own messages are the batch, the rest is the conversation", () => {
    // ROUTE-1 asks about the batch that has just arrived, in the
    // conversation it arrived in, so a label that mixed the two would
    // measure a question routing is never asked.
    const label = labelFrom(
      conversation({
        flag: flag({ turn_id: "turn-2" }),
        messages: [
          message({ turn_id: "turn-1", text: "are you open sunday" }),
          message({
            turn_id: "turn-1",
            direction: "outbound",
            author: "agent",
            text: "yes, 11 to 10",
          }),
          message({ turn_id: "turn-2", text: "book me a table then" }),
        ],
      }),
      "book_table",
    )

    expect(label.batch).toEqual(["book me a table then"])
    expect(label.messages).toEqual([
      { role: "user", text: "are you open sunday" },
      { role: "assistant", text: "yes, 11 to 10" },
    ])
    expect(label.tool).toBe("book_table")
  })

  test("LEARN-5: a voice note is labeled by what it said", () => {
    // MEDIA-1 stores the transcript as what the person said, and routing
    // was asked about that, so a label that skipped it would drop every
    // voice turn out of the labeled set.
    const label = labelFrom(
      conversation({ messages: [message({ text: null, transcript: "table for two" })] }),
      "book_table",
    )
    expect(label.batch).toEqual(["table for two"])
  })
})
