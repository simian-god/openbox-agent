// PRO-5's own conversion, and PRO-2's template line, on their own.
//
// Both are pure, and both decide what a person actually reads, so they are
// worth testing without a database in the way.
import { test, expect, describe } from "bun:test"
import { templateLine, varsOf } from "../../src/runtime/proactive.ts"

describe("PRO-5: an event's data as a template's variables", () => {
  test("PRO-5: strings go through untouched", () => {
    expect(varsOf({ order: "41", name: "Ravi" })).toEqual({ order: "41", name: "Ravi" })
  })

  test("PRO-5: numbers and booleans become text, because a template substitutes text", () => {
    expect(varsOf({ items: 3, express: true, discount: 0 })).toEqual({
      items: "3",
      express: "true",
      discount: "0",
    })
  })

  test("PRO-5: a number that is not a number stays legible, rather than becoming null", () => {
    // Why numbers have a branch of their own rather than going through
    // JSON, which turns both of these into "null". Neither belongs in a
    // customer's message, and "NaN" at least says what went wrong.
    expect(varsOf({ total: Number.NaN })).toEqual({ total: "NaN" })
    expect(varsOf({ total: Number.POSITIVE_INFINITY })).toEqual({ total: "Infinity" })
  })

  test("PRO-5: no data at all is no variables, not a template that cannot be filled", () => {
    expect(varsOf(undefined)).toEqual({})
    expect(varsOf({})).toEqual({})
  })

  test("PRO-5: nothing is dropped silently except what has no value", () => {
    // A variable the template expects and does not get is refused by the
    // channel, so dropping is only right for something that was never
    // there.
    expect(varsOf({ order: "41", note: undefined, cancelled: null })).toEqual({ order: "41" })
  })

  test("PRO-5: an object is written out rather than becoming object Object", () => {
    // Which is a guess about what the builder meant, and the honest one:
    // "[object Object]" in a customer's message is worse than JSON, and
    // dropping it would fail the send instead.
    expect(varsOf({ address: { line1: "12 Main St", city: "Pune" } })).toEqual({
      address: '{"line1":"12 Main St","city":"Pune"}',
    })
    expect(varsOf({ items: ["dal", "roti"] })).toEqual({ items: '["dal","roti"]' })
  })
})

describe("PRO-2: how a template reads in the conversation", () => {
  test("PRO-2: the name and its variables, so the history is not a blank", () => {
    // The person saw the channel's rendering of the template, which the
    // core never sees. This is what the agent's own history records, so a
    // colleague reading it knows what went out.
    expect(templateLine({ name: "order_ready_v1", vars: { order: "41" } })).toContain(
      "order_ready_v1",
    )
    expect(templateLine({ name: "order_ready_v1", vars: { order: "41" } })).toContain("41")
  })

  test("PRO-2: a template with no variables still says which one it was", () => {
    expect(templateLine({ name: "closed_today", vars: {} })).toBe("(template closed_today)")
  })
})
