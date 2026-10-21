// ROUTE-4 and LEARN-5: `openbox tune`.
//
// The threshold decides when routing narrows the tool list. Narrowing can
// only hurt one way: the model was confident and the right tool was not
// among the few it showed. So almost every test here is about that one
// event, a miss, and about not counting things as misses that are not.
//
// The two that matter most are the ones that would otherwise be easy to
// get wrong and impossible to notice:
//
//   A threshold changes what the core does with an answer, not the answer
//   itself, so 101 thresholds must cost exactly as many requests as one.
//
//   Measuring exposure with its own idea of which tools get shown would
//   recommend a threshold for an agent nobody is running, so the measure
//   calls ROUTE-2's own `topTools`.
import { test, expect, describe } from "bun:test"
import { z } from "zod"
import {
  tune,
  measureAt,
  examplesFromTools,
  parseRoutingJsonl,
  mergeExamples,
  DEFAULT_TOLERANCE,
  type Answered,
  type LabeledExample,
  type TuneReport,
} from "../../src/tune/index.ts"
import { writeThreshold, formatReport } from "../../src/cli/tune.ts"
import { defineTool, type Tool } from "../../src/tools/index.ts"
import { scriptedDecisionModel, choice } from "../../src/testing/scripted-decision.ts"
import { NO_TOOL, ROUTING_QUESTION } from "../../src/runtime/routing.ts"
import type { DecisionModel } from "../../src/providers/decision/types.ts"

function tool(name: string, over: { should?: string[]; shouldNot?: string[] } = {}): Tool {
  return defineTool({
    name,
    description: `The ${name} tool.`,
    input: z.object({}),
    risk: "read",
    roles: ["end_user"],
    conditions: {
      callWhen: [`the person asks about ${name}`],
      dontCallWhen: [`the person is not asking about ${name}`],
    },
    examples: {
      should: over.should ?? [`about ${name}`],
      shouldNot: over.shouldNot ?? ["hello"],
    },
    handler: async () => ({ ok: true }),
  })
}

const SIX = ["book", "cancel", "menu", "hours", "directions", "parking"].map((name) => tool(name))
const NAMES = SIX.map((entry) => entry.name)

/** One labeled example, as the tuner holds it. */
const labeled = (text: string, correct: string): LabeledExample => ({
  source: "jsonl",
  where: "test",
  messages: [],
  batch: [text],
  tool: correct,
  role: "end_user",
})

/** One answered example, so a measure can be tested with no model at all. */
const answeredAs = (
  correct: string,
  pick: { choice: string; confidence: number; probabilities?: Record<string, number> },
): Answered => ({
  example: labeled("anything", correct),
  pick: {
    choice: pick.choice,
    confidence: pick.confidence,
    probabilities: pick.probabilities ?? { [pick.choice]: 1 },
  },
  offered: SIX,
})

describe("LEARN-5: where the labeled examples come from", () => {
  test("LEARN-5: a tool's own examples are labeled routing data", () => {
    // TOOL-2 refuses a tool without them, so an agent has a labeled set
    // on the day it is written, before any real traffic.
    const found = examplesFromTools([tool("book", { should: ["book it", "table for four"] })])

    const positives = found.filter((example) => example.tool !== undefined)
    expect(positives.map((example) => example.batch[0])).toEqual(["book it", "table for four"])
    expect(positives.every((example) => example.tool === "book")).toBe(true)
  })

  test("LEARN-5: a shouldNot example says which tool not, and names no replacement", () => {
    const found = examplesFromTools([tool("book", { shouldNot: ["just asking about friday"] })])
    const negative = found.find((example) => example.notTool !== undefined)

    expect(negative?.notTool).toBe("book")
    expect(negative?.tool).toBeUndefined()
  })

  test("LEARN-5: the short form is one message and the tool that should answer it", () => {
    const { examples, problems } = parseRoutingJsonl(
      '{"text": "book a table for four", "tool": "book"}',
      "routing.jsonl",
      NAMES,
    )

    expect(problems).toEqual([])
    expect(examples[0]).toMatchObject({ batch: ["book a table for four"], tool: "book" })
    expect(examples[0]?.messages).toEqual([])
  })

  test("LEARN-5: the full form carries the conversation the tool depends on", () => {
    // The case a single message cannot express, and the one routing most
    // often gets wrong: "four please" is only a booking because of what
    // came before it.
    const line = JSON.stringify({
      messages: [
        { role: "person", text: "any space friday?" },
        { role: "agent", text: "yes, for how many?" },
      ],
      batch: ["four please"],
      tool: "book",
    })
    const { examples, problems } = parseRoutingJsonl(line, "routing.jsonl", NAMES)

    expect(problems).toEqual([])
    expect(examples[0]?.messages).toHaveLength(2)
    expect(examples[0]?.batch).toEqual(["four please"])
  })

  test("LEARN-5: no_tool is a label like any other", () => {
    const { examples, problems } = parseRoutingJsonl(
      `{"text": "thanks!", "tool": "${NO_TOOL}"}`,
      "routing.jsonl",
      NAMES,
    )

    expect(problems).toEqual([])
    expect(examples[0]?.tool).toBe(NO_TOOL)
  })

  test("LEARN-5: blank lines and comments are skipped", () => {
    const { examples, problems } = parseRoutingJsonl(
      ["// reviewed 2026-10-21", "", '{"text": "book it", "tool": "book"}', ""].join("\n"),
      "routing.jsonl",
      NAMES,
    )

    expect(problems).toEqual([])
    expect(examples).toHaveLength(1)
  })

  test("LEARN-5: a label for a tool that does not exist is refused, with its line", () => {
    // It could never be chosen, so it can only ever count as a miss. Much
    // better found here than read as a bad accuracy number.
    const { problems } = parseRoutingJsonl(
      ['{"text": "a", "tool": "book"}', '{"text": "b", "tool": "boook"}'].join("\n"),
      "routing.jsonl",
      NAMES,
    )

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("routing.jsonl:2")
    expect(problems[0]).toContain("boook")
    // And it says what the tools are, so the typo is obvious.
    expect(problems[0]).toContain("book")
  })

  test("LEARN-5: every problem in the file is reported in one pass", () => {
    const { problems } = parseRoutingJsonl(
      ["not json at all", '{"text": "a"}', '{"tool": "book"}', '["a list"]'].join("\n"),
      "routing.jsonl",
      NAMES,
    )

    // Fixing a labeled set one line per run is miserable.
    expect(problems).toHaveLength(4)
    expect(problems[1]).toContain("tool")
    expect(problems[2]).toContain("text")
  })

  test("LEARN-5: a reviewed line wins over a tool's own example for the same message", () => {
    // The reviewed one is what really happened, labeled by someone looking
    // at the consequence rather than imagining it.
    const fromTools = examplesFromTools([tool("book", { should: ["book it"] })])
    const fromFile = parseRoutingJsonl(
      `{"text": "book it", "tool": "${NO_TOOL}"}`,
      "routing.jsonl",
      NAMES,
    ).examples

    const merged = mergeExamples(fromTools, fromFile)
    const forThatMessage = merged.filter((example) => example.batch[0] === "book it")

    expect(forThatMessage).toHaveLength(1)
    expect(forThatMessage[0]?.tool).toBe(NO_TOOL)
    expect(forThatMessage[0]?.source).toBe("jsonl")
  })
})

describe("ROUTE-4: what counts as a miss", () => {
  test("ROUTE-4: below the threshold nothing can be a miss", () => {
    // ROUTE-2: the brain sees every tool, so the right one is reachable
    // however wrong the pick was.
    const at = measureAt([answeredAs("book", { choice: "menu", confidence: 0.2 })], 0.6)

    expect(at.narrowed).toBe(0)
    expect(at.misses).toBe(0)
    expect(at.meanExposed).toBe(6)
  })

  test("ROUTE-4: a confident wrong pick above the threshold is a miss", () => {
    const at = measureAt([answeredAs("book", { choice: "menu", confidence: 0.95 })], 0.6)

    expect(at.narrowed).toBe(1)
    expect(at.misses).toBe(1)
    expect(at.missRate).toBe(1)
  })

  test("ROUTE-4: a confident no_tool when a tool was needed is a miss", () => {
    // The worst narrowing there is: no agent tools at all.
    const at = measureAt([answeredAs("book", { choice: NO_TOOL, confidence: 0.95 })], 0.6)

    expect(at.misses).toBe(1)
    expect(at.meanExposed).toBe(0)
  })

  test("ROUTE-4: a labeled no_tool is never a miss, whatever was shown", () => {
    // Routing showing a tool the brain did not need costs a few tokens.
    // It cannot make the brain call it, and the brain can still answer
    // from the conversation.
    const at = measureAt([answeredAs(NO_TOOL, { choice: "book", confidence: 0.95 })], 0.6)

    expect(at.narrowed).toBe(1)
    expect(at.misses).toBe(0)
  })

  test("ROUTE-4: the right tool second in the spread is still shown, as ROUTE-2 says", () => {
    // ROUTE-2 shows the top tools until their combined probability
    // reaches 0.9. This is the measure calling the production function
    // rather than its own idea of exposure.
    const at = measureAt(
      [
        answeredAs("cancel", {
          choice: "book",
          confidence: 0.6,
          probabilities: { book: 0.55, cancel: 0.4, menu: 0.05 },
        }),
      ],
      0.6,
    )

    expect(at.narrowed).toBe(1)
    expect(at.misses).toBe(0)
    expect(at.meanExposed).toBe(2)
  })

  test("ROUTE-4: ROUTE-2's cap of three still applies, so a fourth place tool is missed", () => {
    const at = measureAt(
      [
        answeredAs("parking", {
          choice: "book",
          confidence: 0.9,
          probabilities: { book: 0.3, cancel: 0.25, menu: 0.2, hours: 0.15, parking: 0.1 },
        }),
      ],
      0.6,
    )

    expect(at.meanExposed).toBe(3)
    expect(at.misses).toBe(1)
  })

  test("ROUTE-4: a negative example is never counted as a miss", () => {
    // It rules one tool out and names no replacement, so it cannot say
    // whether the right tool was shown.
    const negative: Answered = {
      example: {
        source: "tools",
        where: "book.examples.shouldNot",
        messages: [],
        batch: ["just asking"],
        notTool: "book",
        role: "end_user",
      },
      pick: { choice: "book", confidence: 0.99, probabilities: { book: 0.99, menu: 0.01 } },
      offered: SIX,
    }

    const at = measureAt([negative], 0.6)
    expect(at.narrowed).toBe(1)
    expect(at.misses).toBe(0)
  })

  test("ROUTE-4: raising the threshold trades narrowing for misses, in that direction", () => {
    const answered = [
      answeredAs("book", { choice: "book", confidence: 0.95 }),
      answeredAs("cancel", { choice: "menu", confidence: 0.7 }),
      answeredAs("menu", { choice: "hours", confidence: 0.5 }),
    ]

    const low = measureAt(answered, 0.4)
    const high = measureAt(answered, 0.8)

    expect(low.narrowed).toBe(3)
    expect(low.misses).toBe(2)
    expect(high.narrowed).toBe(1)
    expect(high.misses).toBe(0)
  })
})

describe("ROUTE-4: the recommendation", () => {
  /** A model that answers each example in turn from a script. */
  const answering = (picks: { choice: string; probabilities?: Record<string, number> }[]) =>
    scriptedDecisionModel(
      picks.map((pick) => ({
        [ROUTING_QUESTION]: choice(pick.choice, pick.probabilities),
      })),
      { whenExhausted: "throw" },
    )

  const run = (
    model: DecisionModel,
    examples: LabeledExample[],
    over: { tolerance?: number; current?: number } = {},
  ): Promise<TuneReport> =>
    tune({
      decisionModel: model,
      tools: SIX,
      examples,
      current: over.current ?? 0.6,
      ...(over.tolerance !== undefined ? { tolerance: over.tolerance } : {}),
      timeoutMs: 3000,
    })

  test("ROUTE-4: one request per example, however many thresholds are measured", async () => {
    // A threshold changes what the core does with an answer, not the
    // answer. Measuring 101 of them must cost what measuring one costs,
    // or nobody will run this twice.
    const examples = [labeled("book it", "book"), labeled("cancel it", "cancel")]
    const model = answering([{ choice: "book" }, { choice: "cancel" }])

    const report = await run(model, examples)

    expect(model.calls).toHaveLength(2)
    expect(report.requests).toBe(2)
    expect(report.curve).toHaveLength(101)
  })

  test("ROUTE-4: the recommendation is the lowest threshold inside the tolerance", () => {
    const report = {
      tolerance: 0.01,
      curve: [
        { threshold: 0.5, misses: 2, missRate: 0.1 },
        { threshold: 0.7, misses: 0, missRate: 0 },
        { threshold: 0.9, misses: 0, missRate: 0 },
      ],
    }
    // Lowest, because every step up is a turn paying full price for a
    // tool list it did not need. Proven through tune itself below.
    expect(report.curve.find((at) => at.missRate <= report.tolerance)?.threshold).toBe(0.7)
  })

  test("ROUTE-4: tune recommends the lowest threshold that keeps misses inside the tolerance", async () => {
    // Two examples. One is answered confidently and rightly, the other
    // confidently and wrongly at 0.7, so a tolerance of zero has to climb
    // above 0.7 to be safe.
    const examples = [labeled("book it", "book"), labeled("cancel it", "cancel")]
    const model = answering([
      { choice: "book", probabilities: { book: 0.95, no_tool: 0.05 } },
      { choice: "menu", probabilities: { menu: 0.7, hours: 0.3 } },
    ])

    const report = await run(model, examples, { tolerance: 0 })

    expect(report.recommended?.threshold).toBeCloseTo(0.71, 2)
    expect(report.recommended?.misses).toBe(0)
    // And it still narrows the one it was sure about.
    expect(report.recommended?.narrowed).toBe(1)
  })

  test("ROUTE-4: a tolerance that allows one miss settles lower, and narrows more", async () => {
    const examples = [labeled("book it", "book"), labeled("cancel it", "cancel")]
    const model = answering([
      { choice: "book", probabilities: { book: 0.95, no_tool: 0.05 } },
      { choice: "menu", probabilities: { menu: 0.7, hours: 0.3 } },
    ])

    const loose = await run(model, examples, { tolerance: 0.5 })

    expect(loose.recommended?.threshold).toBe(0)
    expect(loose.recommended?.narrowRate).toBe(1)
  })

  test("ROUTE-4: when nothing meets the tolerance it says so rather than inventing a number", async () => {
    // A real answer: on these examples this model cannot narrow this tool
    // list without sometimes hiding the tool that was needed.
    const examples = [labeled("book it", "book")]
    const model = answering([{ choice: "menu" }])

    const report = await run(model, examples, { tolerance: 0 })

    expect(report.recommended).toBeUndefined()
    expect(formatReport(report, "restaurant")).toContain("No threshold keeps misses")
  })

  test("ROUTE-4: a recommendation that narrows nothing is called what it is", async () => {
    // A threshold nothing clears is routing switched off while still being
    // paid for, one request a step. A number that reads like a tuned
    // setting must not hide that.
    const examples = [labeled("book it", "book"), labeled("cancel it", "cancel")]
    const model = answering([
      { choice: "menu", probabilities: { menu: 0.9, hours: 0.1 } },
      { choice: "hours", probabilities: { hours: 0.9, menu: 0.1 } },
    ])

    const report = await run(model, examples, { tolerance: 0 })

    expect(report.recommended?.narrowRate).toBe(0)
    const printed = formatReport(report, "restaurant")
    expect(printed).toContain("almost never narrows")
    expect(printed).toContain("routingMinTools")
  })

  test("ROUTE-4: the default tolerance is one in a hundred", async () => {
    expect(DEFAULT_TOLERANCE).toBe(0.01)
    const examples = [labeled("book it", "book")]
    const report = await run(answering([{ choice: "book" }]), examples)
    expect(report.tolerance).toBe(0.01)
  })

  test("ROUTE-4: an example the model could not answer is left out, not counted as a miss", async () => {
    // A provider that was down says nothing about where a threshold
    // belongs, and folding an outage in would recommend a threshold tuned
    // on a bad afternoon.
    const examples = [labeled("book it", "book"), labeled("cancel it", "cancel")]
    const model = scriptedDecisionModel(
      [{ [ROUTING_QUESTION]: choice("book") }, { throws: "the provider is down" }],
      { whenExhausted: "throw" },
    )

    const report = await run(model, examples)

    expect(report.examples).toBe(1)
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]?.error).toContain("the provider is down")
    expect(report.recommended?.misses).toBe(0)
  })

  test("LEARN-5: the report names the decision model, because a threshold never carries over", async () => {
    const model = scriptedDecisionModel([{ [ROUTING_QUESTION]: choice("book") }], { id: "jev" })
    const report = await run(model, [labeled("book it", "book")])

    expect(report.model).toBe("jev")
  })

  test("C8: a tool that does not exist is counted, and there should never be one", async () => {
    // Both adapters refuse an answer naming an option they did not offer,
    // so this counts what got past that. A hand written model could.
    const invents: DecisionModel = {
      id: "invents",
      ask: async () => ({
        answers: {
          [ROUTING_QUESTION]: {
            type: "choice",
            choice: "teleport_the_table",
            probabilities: { teleport_the_table: 1 },
            confidence: 1,
          },
        },
        usage: { inputTokens: 1 },
      }),
    }

    const report = await run(invents, [labeled("book it", "book")])
    expect(report.invented).toBe(1)
  })

  test("LEARN-5: a shouldNot example whose own tool was picked anyway is reported", async () => {
    // Calling a write tool one message too early is the most common real
    // routing fault, and this is the only labeled evidence of it an agent
    // has for free.
    const examples = examplesFromTools([
      tool("book", { should: ["book it"], shouldNot: ["just asking about friday"] }),
    ])
    const model = answering([{ choice: "book" }, { choice: "book" }])

    const report = await run(model, examples)

    expect(report.negatives).toBe(1)
    expect(report.pickedWarnedAgainst).toBe(1)
  })

  test("ROUTE-4: top pick accuracy is reported over the positives only", async () => {
    const examples = [
      labeled("book it", "book"),
      labeled("cancel it", "cancel"),
      labeled("the menu", "menu"),
    ]
    const model = answering([{ choice: "book" }, { choice: "cancel" }, { choice: "hours" }])

    const report = await run(model, examples)

    expect(report.positives).toBe(3)
    expect(report.topPickCorrect).toBe(2)
    expect(report.topPickRate).toBeCloseTo(2 / 3)
  })

  test("the report says what config does today, next to what is recommended", async () => {
    const examples = [labeled("book it", "book")]
    const model = answering([{ choice: "book", probabilities: { book: 0.8, no_tool: 0.2 } }])

    const report = await run(model, examples, { current: 0.6 })

    expect(report.current.threshold).toBe(0.6)
    const printed = formatReport(report, "restaurant")
    expect(printed).toContain("config")
    expect(printed).toContain("recommended")
  })
})

describe("LEARN-7: tune never changes config on its own", () => {
  const CONFIG = `export default defineConfig({
  name: "restaurant",
  decisionModel: { id: "jev", routeThreshold: 0.6 },
})
`

  test("LEARN-7: with --write it replaces exactly the one number", () => {
    const written = writeThreshold(CONFIG, 0.72)

    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.text).toContain("routeThreshold: 0.72")
    // And nothing else moved.
    expect(written.text).toContain(`name: "restaurant"`)
    expect(written.text.split("\n")).toHaveLength(CONFIG.split("\n").length)
  })

  test("LEARN-7: a config with no routeThreshold is not restructured, it is explained", () => {
    // The field has a default, so a builder may never have written it.
    // Guessing where in a hand written file an object should gain a key is
    // not worth saving them one paste.
    const written = writeThreshold(`export default defineConfig({ name: "x" })`, 0.72)

    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.why).toContain("routeThreshold: 0.72")
  })

  test("LEARN-7: two routeThresholds in one file is refused rather than guessed at", () => {
    const twice = `// routeThreshold: 0.5 was the old value\n${CONFIG}`
    const written = writeThreshold(twice, 0.72)

    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.why).toContain("2 times")
  })
})
