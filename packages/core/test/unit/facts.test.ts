// Section 10's `remember` and `forget_fact`, and the key normalising that
// makes them one memory rather than several.
//
// A fact is the only thing in this system the brain writes and then reads
// back as truth on every later turn. So a bad one does not pass: it sits
// in the runtime block being believed. Most of these tests are about what
// the tools refuse for that reason.
import { test, expect, describe } from "bun:test"
import { factKey, factTools, MAX_FACT_VALUE, MAX_FACTS } from "../../src/tools/facts.ts"
import { isBuiltinToolName } from "../../src/tools/builtins.ts"
import { createStore } from "../../src/store/index.ts"
import { fixedClock } from "../../src/testing/clock.ts"

const tools = () =>
  factTools({
    store: createStore({ from: () => ({}) } as never, "restaurant"),
    clock: fixedClock("2026-10-19T06:00:00Z"),
  })

describe("section 10: the key one memory hangs on", () => {
  test("a key is lower case, so Allergies and allergies are one fact", () => {
    expect(factKey("Allergies")).toBe("allergies")
    expect(factKey("ALLERGIES")).toBe("allergies")
  })

  test("spaces and dashes become underscores", () => {
    expect(factKey("usual order")).toBe("usual_order")
    expect(factKey("usual-order")).toBe("usual_order")
    expect(factKey("  usual   order  ")).toBe("usual_order")
  })

  test("punctuation is dropped rather than kept as part of the name", () => {
    expect(factKey("allergies?")).toBe("allergies")
    expect(factKey("child's name")).toBe("childs_name")
  })

  test("runs of underscores collapse, and the ends are trimmed", () => {
    expect(factKey("_usual__order_")).toBe("usual_order")
  })

  test("a key with nothing usable in it comes back empty, so it can be refused", () => {
    // Rather than becoming "" silently and overwriting whatever "" held.
    expect(factKey("???")).toBe("")
    expect(factKey("   ")).toBe("")
  })

  test("the same words written three ways are the same key", () => {
    const ways = ["Usual Order", "usual-order", "  USUAL   order "]
    expect(new Set(ways.map(factKey)).size).toBe(1)
  })
})

describe("BUILTIN-1: they are the core's tools", () => {
  test("both are section 10 built ins", () => {
    expect(tools().map((tool) => tool.name)).toEqual(["remember", "forget_fact"])
    expect(tools().every((tool) => isBuiltinToolName(tool.name))).toBe(true)
    expect(tools().every((tool) => tool.builtin)).toBe(true)
  })

  test("neither is gated, because neither does anything in the world", () => {
    // Section 10: only erase_person is gated and confirmed.
    expect(tools().every((tool) => tool.risk === "read")).toBe(true)
  })

  test("they are an end user's, so an operator is offered neither", () => {
    expect(tools().map((tool) => tool.roles)).toEqual([["end_user"], ["end_user"]])
  })

  test("TOOL-2: both meet every rule an agent tool does", () => {
    for (const tool of tools()) {
      expect(tool.conditions.callWhen.length).toBeGreaterThan(0)
      expect(tool.conditions.dontCallWhen.length).toBeGreaterThan(0)
      expect(tool.examples.should.length).toBeGreaterThan(0)
      expect(tool.examples.shouldNot.length).toBeGreaterThan(0)
    }
  })

  test("remember tells the brain what not to use it for", () => {
    // The two ways a brain misuses this: storing the current request, and
    // storing something it worked out rather than was told.
    const remember = tools()[0]
    const dont = remember?.conditions.dontCallWhen.join(" ") ?? ""
    expect(dont).toContain("task")
    expect(dont).toContain("inferred")
  })

  test("forget_fact says it is for the person asking, not for tidying up", () => {
    const forget = tools()[1]
    const dont = forget?.conditions.dontCallWhen.join(" ") ?? ""
    expect(dont).toContain("remember, which replaces it")
  })
})

describe("the limits", () => {
  test("a value has a length, and it is long enough for a sentence", () => {
    expect(MAX_FACT_VALUE).toBeGreaterThanOrEqual(200)
  })

  test("a person has a number of facts, and it is more than anyone needs", () => {
    expect(MAX_FACTS).toBeGreaterThanOrEqual(20)
  })
})
