// C8: is routing worth it?
//
// The script answers each labeled example twice, once with the tools
// routing chose and once with every tool, and compares. These tests are
// about the comparison being honest, which comes down to three things that
// would be easy to get wrong and hard to notice:
//
//   The routed arm has to be charged for its own decision request, in time
//   and in money. Leaving that out would make routing look free and the
//   measurement worthless.
//
//   A fake brain costs nothing and answers at once, so the routed arm can
//   only ever look worse on it. A pass claimed on a fake is a lie.
//
//   Accuracy has to be measured the way the agent is actually run, which
//   means a below threshold pick exposes everything and the two arms give
//   the same answer.
import { test, expect, describe } from "bun:test"
import { z } from "zod"
import { measureC8, formatC8, median, loadForC8, type C8Report } from "../../../../scripts/c8.ts"
import { defineTool, type Risk, type Tool } from "../../src/tools/index.ts"
import { scriptedBrain, type ScriptedStep } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, choice } from "../../src/testing/scripted-decision.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { ROUTING_QUESTION } from "../../src/runtime/routing.ts"
import type { LabeledExample } from "../../src/tune/index.ts"
import type { Brain } from "../../src/providers/brains/types.ts"
import { join } from "node:path"

const FIXTURE = join(import.meta.dir, "..", "fixtures", "routing-agent")

function tool(name: string, risk: Risk = "read"): Tool {
  return defineTool({
    name,
    description: `The ${name} tool.`,
    input: z.object({}),
    risk,
    roles: ["end_user"],
    conditions: {
      callWhen: [`the person asks about ${name}`],
      dontCallWhen: [`the person is not asking about ${name}`],
    },
    examples: { should: [`about ${name}`], shouldNot: ["hello"] },
    ...(risk === "irreversible" ? { confirmSummary: () => `${name}?` } : {}),
    handler: async () => ({ ok: true }),
  })
}

const SIX = ["book", "cancel", "menu", "hours", "directions", "parking"].map((name) => tool(name))

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: [["11:00", "23:00"]] },
    brain: { id: "openrouter", model: "test/model" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages.",
    retentionDays: 365,
    ...over,
  })
}

const labeled = (text: string, correct: string): LabeledExample => ({
  source: "jsonl",
  where: `example:${text}`,
  messages: [],
  batch: [text],
  tool: correct,
  role: "end_user",
})

/**
 * A brain that reaches for one tool, and replies instead when it was not
 * offered it.
 *
 * That last part is the whole point of the fake. A real brain can only call
 * what it was shown, so a brain that called a tool routing had hidden would
 * make routing look harmless when it had just cost the agent the answer.
 *
 * Its cost moves with how many tools it was shown, because a real brain
 * pays for every tool schema in its input, and that saving is what bar 2
 * is asking about.
 */
function brainCalling(name: string | null, costUsd = 0.0001, msPerTool = 0): Brain {
  return {
    id: "openrouter",
    kind: "api",
    supportsImages: false,
    complete: async (input) => {
      if (msPerTool > 0) {
        await new Promise((resolve) => setTimeout(resolve, msPerTool * input.tools.length))
      }
      const offered = input.tools.some((tool) => tool.name === name)
      return {
        ...(name === null || !offered
          ? { text: "Here you go.", finishReason: "stop" }
          : { toolCalls: [{ id: "c1", name, input: {} }], finishReason: "tool_calls" }),
        usage: {
          inputTokens: 100 * input.tools.length,
          outputTokens: 10,
          costUsd: costUsd * input.tools.length,
        },
      }
    },
  }
}

/** A brain that calls something it was never offered (C8's first bar). */
function brainInventing(name: string): Brain {
  return {
    id: "openrouter",
    kind: "api",
    supportsImages: false,
    complete: async () => ({
      toolCalls: [{ id: "c1", name, input: {} }],
      finishReason: "tool_calls",
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.0001 },
    }),
  }
}

const run = (
  brain: Brain,
  decisionModel: Parameters<typeof measureC8>[0]["decisionModel"],
  examples: LabeledExample[],
  over: Partial<Parameters<typeof measureC8>[0]> = {},
): Promise<C8Report> =>
  measureC8({
    brain,
    model: "test/model",
    decisionModel,
    tools: SIX,
    examples,
    prompt: "You are the host.",
    config: config(),
    ...over,
  })

/** A decision model that is confident about one tool, every time. */
const sureAbout = (name: string, costUsd = 0.00002) =>
  scriptedDecisionModel([{ [ROUTING_QUESTION]: choice(name, { [name]: 0.95, no_tool: 0.05 }) }], {
    costUsd,
  })

describe("C8: the two arms", () => {
  test("C8: each example is answered twice, once per arm", async () => {
    const brain = brainCalling("book")
    const report = await run(brain, sureAbout("book"), [labeled("about book", "book")])

    expect(report.routed.answered).toBe(1)
    expect(report.allTools.answered).toBe(1)
    // One tool shown against six: the thing routing is for.
    expect(report.routed.meanExposed).toBe(1)
    expect(report.allTools.meanExposed).toBe(6)
  })

  test("C8: the routed arm pays for its own decision request", async () => {
    // Without this the measurement is worthless: routing would look free,
    // and the only question C8 asks is whether the trade comes out ahead.
    const brain = brainCalling("book", 0.0001)
    const report = await run(brain, sureAbout("book", 0.00002), [labeled("about book", "book")])

    // One tool shown, so one unit of brain cost, plus the decision request.
    expect(report.routed.medianCostUsd).toBeCloseTo(0.0001 + 0.00002, 7)
    // Six tools shown, and no decision request.
    expect(report.allTools.medianCostUsd).toBeCloseTo(0.0006, 7)
  })

  test("C8: routing that narrows a six tool list comes out cheaper and faster", async () => {
    // Bar 2 asks for both, so the brain here takes time per tool shown as
    // well as money, which is how a real one behaves.
    const report = await run(brainCalling("book", 0.0001, 10), sureAbout("book"), [
      labeled("about book", "book"),
      labeled("about cancel", "book"),
    ])

    expect(report.routed.medianCostUsd).toBeLessThan(report.allTools.medianCostUsd)
    expect(report.routed.medianLatencyMs).toBeLessThan(report.allTools.medianLatencyMs)
    expect(report.bars.find((bar) => bar.id === "C8.2")?.pass).toBe(true)
  })

  test("C8: faster but not cheaper is not a pass either", async () => {
    // The mirror of the test below, and the case that actually bites in
    // real life: a brain whose price barely moves with the tool list, so
    // routing buys some speed and the decision request eats the saving.
    const flatPrice: Brain = {
      id: "openrouter",
      kind: "api",
      supportsImages: false,
      complete: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 10 * input.tools.length))
        return {
          toolCalls: [{ id: "c1", name: "book", input: {} }],
          finishReason: "tool_calls",
          usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.0001 },
        }
      },
    }

    const report = await run(flatPrice, sureAbout("book", 0.00005), [labeled("about book", "book")])

    expect(report.routed.medianLatencyMs).toBeLessThan(report.allTools.medianLatencyMs)
    expect(report.routed.medianCostUsd).toBeGreaterThan(report.allTools.medianCostUsd)
    expect(report.bars.find((bar) => bar.id === "C8.2")?.pass).toBe(false)
  })

  test("C8: cheaper but not faster is not a pass, because bar 2 asks for both", async () => {
    // A brain that takes the same time whatever it is shown, so routing
    // buys nothing in latency and still pays for a decision request. The
    // first version of this test used an instant brain and compared 0 ms
    // with 0 ms, which came out either way on timer jitter.
    const slowToDecide = {
      id: "scripted",
      ask: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        return {
          answers: {
            [ROUTING_QUESTION]: {
              type: "choice" as const,
              choice: "book",
              probabilities: { book: 0.95, no_tool: 0.05 },
              confidence: 0.95,
            },
          },
          usage: { inputTokens: 10, costUsd: 0.00001 },
        }
      },
    }

    const report = await run(brainCalling("book"), slowToDecide, [labeled("about book", "book")])

    expect(report.routed.medianCostUsd).toBeLessThan(report.allTools.medianCostUsd)
    expect(report.routed.medianLatencyMs).toBeGreaterThan(report.allTools.medianLatencyMs)
    expect(report.bars.find((bar) => bar.id === "C8.2")?.pass).toBe(false)
  })

  test("C8: a below threshold pick makes the two arms identical", async () => {
    // ROUTE-2: the brain sees everything, so routing has bought nothing
    // and cost a request. The measurement has to show that, not hide it.
    const unsure = scriptedDecisionModel(
      [{ [ROUTING_QUESTION]: choice("book", { book: 0.3, cancel: 0.3, no_tool: 0.4 }, 0.3) }],
      { costUsd: 0.00002 },
    )
    const report = await run(brainCalling("book"), unsure, [labeled("about book", "book")])

    expect(report.routed.meanExposed).toBe(6)
    expect(report.allTools.meanExposed).toBe(6)
    expect(report.routed.medianCostUsd).toBeGreaterThan(report.allTools.medianCostUsd)
  })
})

describe("C8: the three bars", () => {
  test("C8.1: a tool call naming something never offered is counted", async () => {
    // LOOP-8 step 5 rejects these at runtime. C8's first bar is that they
    // never happen at all.
    const report = await run(brainInventing("teleport_the_table"), sureAbout("book"), [
      labeled("about book", "book"),
    ])

    expect(report.routed.invented).toBe(1)
    expect(report.bars.find((bar) => bar.id === "C8.1")?.pass).toBe(false)
  })

  test("C8.1: passes when every call names a tool that was offered", async () => {
    const report = await run(brainCalling("book"), sureAbout("book"), [
      labeled("about book", "book"),
    ])

    expect(report.bars.find((bar) => bar.id === "C8.1")?.pass).toBe(true)
  })

  test("C8.2: a fake brain is never reported as a pass", async () => {
    // It costs nothing and answers at once, so the routed arm pays a
    // decision request and saves nothing. A pass here would be a lie.
    const scripted = scriptedBrain([{ tool: "book", input: {} }] as ScriptedStep[])
    const report = await run(scripted, sureAbout("book"), [labeled("about book", "book")])

    expect(report.simulated).toBe(true)
    expect(report.costReported).toBe(false)
    expect(report.bars.find((entry) => entry.id === "C8.2")?.pass).toBe(false)
    expect(formatC8(report, "restaurant")).toContain("scripted fake")
  })

  test("C8.2: a real brain that reports no cost says so, rather than printing zeroes", async () => {
    // Not a hypothetical. A provider that leaves cost out of its usage
    // object would otherwise produce "FAIL, cost 0.000000 vs 0.000000",
    // which reads like a measurement and is the absence of one. The
    // pricing table that would fill the gap is LIMIT-3, in M7.
    const silent: Brain = {
      id: "openrouter",
      kind: "api",
      supportsImages: false,
      complete: async (input) => ({
        toolCalls: [{ id: "c1", name: input.tools[0]?.name ?? "book", input: {} }],
        finishReason: "tool_calls",
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
    }

    const report = await run(silent, sureAbout("book"), [labeled("about book", "book")])

    expect(report.simulated).toBe(false)
    expect(report.costReported).toBe(false)
    const bar = report.bars.find((entry) => entry.id === "C8.2")
    expect(bar?.pass).toBe(false)
    expect(bar?.detail).toContain("reported no cost")
    expect(formatC8(report, "restaurant")).toContain("LIMIT-3")
  })

  test("C8.2: the brain's own cost is counted apart from the decision request's", async () => {
    // Which is what lets bar 2 tell "the brain said nothing" apart from
    // "the brain cost nothing because routing paid for everything".
    const report = await run(brainCalling("book", 0.0001), sureAbout("book", 0.00002), [
      labeled("about book", "book"),
    ])

    expect(report.costReported).toBe(true)
    expect(report.routed.totalBrainCostUsd).toBeCloseTo(0.0001, 7)
    expect(report.routed.totalCostUsd).toBeCloseTo(0.00012, 7)
  })

  test("C8.3: accuracy is at least as good as the brain alone", async () => {
    const report = await run(brainCalling("book"), sureAbout("book"), [
      labeled("about book", "book"),
    ])

    expect(report.routed.accuracy).toBe(1)
    expect(report.allTools.accuracy).toBe(1)
    expect(report.bars.find((bar) => bar.id === "C8.3")?.pass).toBe(true)
  })

  test("C8.3: fails when narrowing cost the brain the right tool", async () => {
    // The only way routing can hurt. Routing is sure about `cancel`, the
    // label says `book`, so the routed arm was never shown the right tool
    // and the brain replied instead of calling it.
    const report = await run(brainCalling("book"), sureAbout("cancel"), [
      labeled("about book", "book"),
    ])

    expect(report.routed.accuracy).toBe(0)
    expect(report.allTools.accuracy).toBe(1)
    // And nothing was invented: the brain only called what it was shown.
    expect(report.routed.invented).toBe(0)
    expect(report.bars.find((bar) => bar.id === "C8.3")?.pass).toBe(false)
    expect(report.pass).toBe(false)
  })

  test("C8: a labeled no_tool is right when the brain replies instead of calling", async () => {
    const report = await run(brainCalling(null), sureAbout("book"), [
      labeled("thanks, see you then", "no_tool"),
    ])

    expect(report.routed.accuracy).toBe(1)
    expect(report.allTools.accuracy).toBe(1)
  })

  test("C8: a brain that calls a tool on a no_tool example is wrong", async () => {
    const report = await run(brainCalling("book"), sureAbout("book"), [
      labeled("thanks, see you then", "no_tool"),
    ])

    expect(report.routed.accuracy).toBe(0)
  })
})

describe("C8: the measurement itself", () => {
  test("C8: a brain that throws is left out rather than counted as wrong", async () => {
    const broken: Brain = {
      id: "openrouter",
      kind: "api",
      supportsImages: false,
      complete: async () => {
        throw new Error("502 from the provider")
      },
    }
    const report = await run(broken, sureAbout("book"), [labeled("about book", "book")])

    expect(report.routed.answered).toBe(0)
    expect(report.routed.errors).toBe(1)
    expect(report.routed.accuracy).toBe(0)
  })

  test("C8: repeats answer each example again, for a steadier median", async () => {
    const brain = brainCalling("book")
    const report = await run(brain, sureAbout("book"), [labeled("about book", "book")], {
      repeats: 3,
    })

    expect(report.repeats).toBe(3)
    expect(report.routed.answered).toBe(3)
    expect(report.allTools.answered).toBe(3)
  })

  test("C8: the median of an even number of values is the middle pair", () => {
    expect(median([])).toBe(0)
    expect(median([5])).toBe(5)
    expect(median([1, 2, 3])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    // Order should not matter.
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  test("C8: a tool another role owns is in neither arm", async () => {
    const operatorOnly = defineTool({
      name: "operator_report",
      description: "An operator only report.",
      input: z.object({}),
      risk: "read",
      roles: ["operator"],
      conditions: { callWhen: ["an operator asks"], dontCallWhen: ["an end user asks"] },
      examples: { should: ["report"], shouldNot: ["hello"] },
      handler: async () => ({ ok: true }),
    })

    const report = await run(
      brainCalling("book"),
      sureAbout("book"),
      [labeled("about book", "book")],
      { tools: [...SIX, operatorOnly] },
    )

    // ROLE-3 removed it from the options, so both arms see six.
    expect(report.allTools.meanExposed).toBe(6)
  })

  test("C8: the report says which brain and which decision model it measured", async () => {
    const report = await run(brainCalling("book"), sureAbout("book"), [
      labeled("about book", "book"),
    ])

    const printed = formatC8(report, "restaurant")
    expect(printed).toContain("openrouter")
    expect(printed).toContain("scripted")
    expect(printed).toContain("routed")
    expect(printed).toContain("all tools")
  })
})

describe("C8: the fixture it is measured on", () => {
  test("C8: the fixture agent has enough tools for routing to run", async () => {
    // The demo agent has one tool, so routing never runs there and C8 has
    // no two arms to compare. That is why this fixture exists.
    const loaded = await loadForC8(FIXTURE)

    expect(loaded.tools.length).toBeGreaterThan(loaded.config.routingMinTools)
    expect(loaded.config.name).toBe("routing-fixture")
  })

  test("C8: the fixture covers all three risk levels, so the gate is in the picture", async () => {
    const loaded = await loadForC8(FIXTURE)
    const risks = new Set(loaded.tools.map((tool) => tool.risk))

    expect([...risks].sort()).toEqual(["irreversible", "read", "write"])
  })

  test("C8: the fixture's labeled set loads, and its labels name real tools", async () => {
    // parseRoutingJsonl refuses a label for a tool that does not exist, so
    // loading at all is the check. This holds the file to the tools.
    const loaded = await loadForC8(FIXTURE)
    const names = new Set([...loaded.tools.map((tool) => tool.name), "no_tool"])

    expect(loaded.examples.length).toBeGreaterThan(30)
    for (const example of loaded.examples) {
      if (example.tool !== undefined) expect(names.has(example.tool)).toBe(true)
    }
  })

  test("C8: the fixture includes examples a single message cannot express", async () => {
    // "four of us, around 8" is only an availability question because of
    // the message above it, and those are the turns routing gets wrong.
    const loaded = await loadForC8(FIXTURE)
    const withHistory = loaded.examples.filter((example) => example.messages.length > 0)

    expect(withHistory.length).toBeGreaterThan(4)
  })

  test("C8: it refuses an agent routing never runs for", async () => {
    // The demo agent, which is the case this guard exists for.
    const demo = join(import.meta.dir, "..", "..", "..", "..", "examples", "demo-agent")
    const loaded = await loadForC8(demo)

    expect(loaded.tools.length).toBeLessThanOrEqual(loaded.config.routingMinTools)
  })
})
