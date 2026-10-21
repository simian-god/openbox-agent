// ROUTE-1 to ROUTE-5, DM-3 and BUILTIN-1: which tools the brain is shown.
//
// Routing exists to keep a large agent's tool list short enough for the
// brain to choose well, and it has to do that without ever making a tool
// unreachable. So the rule that matters most here is the one in ROUTE-2's
// third line: when the decision model is not confident, the brain sees
// EVERYTHING. Narrowing is an optimisation, and an optimisation that is
// not sure of itself must not remove the right answer.
//
// The same holds when the decision model is down (ROUTE-5): the step
// carries on with every tool exposed. Routing is the one place in the core
// that fails open, and it can only do that because the gate (T3.5) is what
// actually decides whether a call runs.
import { test, expect, describe } from "bun:test"
import { z } from "zod"
import {
  route,
  routingQuestion,
  NO_TOOL,
  ROUTING_QUESTION,
  type RouteDecision,
} from "../../src/runtime/routing.ts"
import { defineTool, type Risk, type Tool } from "../../src/tools/index.ts"
import { scriptedDecisionModel, choice } from "../../src/testing/scripted-decision.ts"
import { DecisionError, type DecisionModel } from "../../src/providers/decision/types.ts"

function tool(name: string, risk: Risk = "read"): Tool {
  return defineTool({
    name,
    description: `The ${name} tool.`,
    input: z.object({ when: z.string() }),
    risk,
    roles: ["end_user"],
    conditions: {
      callWhen: [`the person asks about ${name}`],
      dontCallWhen: [`the person is not asking about ${name}`],
    },
    examples: { should: [`do ${name}`], shouldNot: ["hello"] },
    ...(risk === "irreversible" ? { confirmSummary: () => `do ${name}?` } : {}),
    handler: async () => ({ ok: true }),
  })
}

/** Six tools, which is one more than the default that turns routing on. */
const SIX = ["check_availability", "read_menu", "book", "cancel", "hours", "directions"].map(
  (name) => tool(name),
)

const STATE = {
  messages: [
    { role: "person", text: "do you have a table on Monday?" },
    { role: "agent", text: "for how many?" },
  ],
  batch: ["four of us"],
  activeTask: null,
}

const names = (decision: RouteDecision) => decision.tools.map((t) => t.name)

const ask = (
  model: DecisionModel,
  overrides: Partial<Parameters<typeof route>[0]> = {},
): Promise<RouteDecision> =>
  route({
    decisionModel: model,
    tools: SIX,
    state: STATE,
    minTools: 5,
    threshold: 0.6,
    timeoutMs: 3000,
    ...overrides,
  })

describe("ROUTE-1: what the decision model is asked", () => {
  test("ROUTE-1: the options are every tool the role allows, plus no_tool", async () => {
    const model = scriptedDecisionModel([{ [ROUTING_QUESTION]: choice("book") }])
    await ask(model)

    const question = model.calls[0]?.questions[ROUTING_QUESTION]
    expect(question?.type).toBe("choice")
    const options = (question as { options: Record<string, string | null> }).options
    expect(Object.keys(options).sort()).toEqual([...SIX.map((t) => t.name), NO_TOOL].sort())
  })

  test("ROUTE-1: each option is described by TOOL-3's text, not just its name", async () => {
    const model = scriptedDecisionModel([{ [ROUTING_QUESTION]: choice("book") }])
    await ask(model)

    const options = (
      model.calls[0]?.questions[ROUTING_QUESTION] as { options: Record<string, string | null> }
    ).options
    const book = SIX.find((t) => t.name === "book")!
    expect(options["book"]).toBe(book.brainDescription)
    // TOOL-3's text is the description plus the call when and don't call
    // when lines, which is what makes the choice answerable.
    expect(options["book"]).toContain("Call when:")
    expect(options["book"]).toContain("Don't call when:")
  })

  test("ROUTE-1: no_tool says what it means, so it is a real option", async () => {
    const model = scriptedDecisionModel([{ [ROUTING_QUESTION]: choice("book") }])
    await ask(model)

    const options = (
      model.calls[0]?.questions[ROUTING_QUESTION] as { options: Record<string, string | null> }
    ).options
    expect(options[NO_TOOL]).toBe("Answer from the conversation and knowledge, no action needed")
  })

  test("ROUTE-1: the state is the recent messages, the batch and the active task", async () => {
    const model = scriptedDecisionModel([{ [ROUTING_QUESTION]: choice("book") }])
    await ask(model)

    expect(model.calls[0]?.state).toEqual(STATE)
  })

  test("ROUTE-1: the question is built the same way by routingQuestion, so the gate can reuse it", () => {
    const question = routingQuestion(SIX)
    expect(question.type).toBe("choice")
    expect(Object.keys(question.options)).toHaveLength(SIX.length + 1)
  })
})

describe("ROUTE-2: what the brain gets", () => {
  test("ROUTE-2: a confident top pick exposes the top tools until 0.9 is reached", async () => {
    const model = scriptedDecisionModel([
      {
        [ROUTING_QUESTION]: choice("book", {
          book: 0.7,
          check_availability: 0.25,
          read_menu: 0.03,
          cancel: 0.02,
        }),
      },
    ])

    const decision = await ask(model)

    // 0.7 then 0.95, so two tools carry it past 0.9 and the rest are left
    // out. The winner is first.
    expect(names(decision)).toEqual(["book", "check_availability"])
    expect(decision.reason).toBe("top_pick")
  })

  test("ROUTE-2: at most 3 tools, however flat the spread is", async () => {
    const model = scriptedDecisionModel([
      {
        [ROUTING_QUESTION]: choice("book", {
          book: 0.25,
          check_availability: 0.2,
          read_menu: 0.2,
          cancel: 0.15,
          hours: 0.1,
          directions: 0.1,
        }),
      },
    ])

    // Confidence is the winner's own 0.25 here, which is below the
    // threshold, so the threshold is lowered to isolate the cap.
    const decision = await ask(model, { threshold: 0.2 })

    expect(decision.tools).toHaveLength(3)
    expect(names(decision)[0]).toBe("book")
  })

  test("ROUTE-2: a confident no_tool exposes no agent tools at all", async () => {
    const model = scriptedDecisionModel([
      {
        [ROUTING_QUESTION]: choice(NO_TOOL, { [NO_TOOL]: 0.95, book: 0.05 }),
      },
    ])

    const decision = await ask(model)

    expect(decision.tools).toEqual([])
    expect(decision.reason).toBe("no_tool")
  })

  test("ROUTE-2: a pick below the threshold exposes every tool the role allows", async () => {
    // The rule that keeps routing safe. An unsure narrowing would make the
    // right tool unreachable, so it narrows nothing.
    const model = scriptedDecisionModel([
      {
        [ROUTING_QUESTION]: choice("book", {
          book: 0.4,
          check_availability: 0.35,
          read_menu: 0.25,
        }),
      },
    ])

    const decision = await ask(model)

    expect(names(decision)).toEqual(SIX.map((t) => t.name))
    expect(decision.reason).toBe("below_threshold")
  })

  test("ROUTE-2: no_tool below the threshold still exposes everything", async () => {
    // Not an instruction to answer from the conversation: an unsure
    // no_tool is just an unsure answer.
    const model = scriptedDecisionModel([
      { [ROUTING_QUESTION]: choice(NO_TOOL, { [NO_TOOL]: 0.5, book: 0.5 }) },
    ])

    const decision = await ask(model)

    expect(names(decision)).toEqual(SIX.map((t) => t.name))
    expect(decision.reason).toBe("below_threshold")
  })

  test("ROUTE-2: exactly at the threshold counts as confident", async () => {
    const model = scriptedDecisionModel([
      { [ROUTING_QUESTION]: choice("book", { book: 0.6, read_menu: 0.4 }) },
    ])

    const decision = await ask(model, { threshold: 0.6 })

    expect(decision.reason).toBe("top_pick")
  })

  test("ROUTE-1: five tools or fewer is not routed, and costs no decision request", async () => {
    const model = scriptedDecisionModel([{ [ROUTING_QUESTION]: choice("book") }])
    const five = SIX.slice(0, 5)

    const decision = await route({
      decisionModel: model,
      tools: five,
      state: STATE,
      minTools: 5,
      threshold: 0.6,
      timeoutMs: 3000,
    })

    expect(names(decision)).toEqual(five.map((t) => t.name))
    expect(decision.reason).toBe("not_routed")
    // Nothing was asked, so nothing was paid for.
    expect(model.calls).toHaveLength(0)
    expect(decision.requests).toBe(0)
  })

  test("ROUTE-1: six tools is routed, because the rule is more than five", async () => {
    const model = scriptedDecisionModel([{ [ROUTING_QUESTION]: choice("book") }])
    const decision = await ask(model)

    expect(model.calls).toHaveLength(1)
    expect(decision.reason).toBe("top_pick")
  })

  test("ROUTE-4: the threshold comes from the caller, so config decides it", async () => {
    const script = () => [
      {
        [ROUTING_QUESTION]: choice("book", { book: 0.55, check_availability: 0.45 }),
      },
    ]

    const strict = await ask(scriptedDecisionModel(script()), { threshold: 0.6 })
    const lenient = await ask(scriptedDecisionModel(script()), { threshold: 0.5 })

    expect(strict.reason).toBe("below_threshold")
    expect(lenient.reason).toBe("top_pick")
  })

  test("ROUTE-2: a tool the model names but the role does not allow is ignored", async () => {
    // The scripted model refuses an unoffered choice, so this is the
    // weaker case: a spread that mentions one.
    const model = scriptedDecisionModel([
      {
        [ROUTING_QUESTION]: choice("book", { book: 0.6, admin_refund: 0.4 }),
      },
    ])

    const decision = await ask(model)

    expect(names(decision)).toEqual(["book"])
  })
})

describe("ROUTE-5: when the decision model does not answer", () => {
  test("ROUTE-5: a failure exposes every tool and says it fell back", async () => {
    const model = scriptedDecisionModel([{ throws: "the provider is down", retryable: true }])

    const decision = await ask(model)

    expect(names(decision)).toEqual(SIX.map((t) => t.name))
    expect(decision.reason).toBe("fallback")
    expect(decision.error).toMatch(/the provider is down/)
  })

  test("ROUTE-5: a timeout exposes every tool, and does not wait longer than it was given", async () => {
    const hangs: DecisionModel = {
      id: "hangs",
      ask: () => new Promise(() => {}),
    }

    const started = Date.now()
    const decision = await ask(hangs, { timeoutMs: 50 })
    const waited = Date.now() - started

    expect(decision.reason).toBe("fallback")
    expect(names(decision)).toEqual(SIX.map((t) => t.name))
    expect(decision.error).toMatch(/50/)
    // Generous, because a loaded machine is slow, but far below the
    // default 3 seconds this would otherwise have waited.
    expect(waited).toBeLessThan(1500)
  })

  test("ROUTE-5: routing does not retry, even when the failure says it is worth it", async () => {
    // A step has a few seconds in total. Retrying inside routing would
    // spend the person's wait on an optimisation, so the step carries on
    // with every tool instead.
    const model = scriptedDecisionModel([{ throws: "overloaded", retryable: true }])

    const decision = await ask(model)

    expect(model.calls).toHaveLength(1)
    expect(decision.reason).toBe("fallback")
  })

  test("ROUTE-5: an answer that cannot be read is a fallback, not a crash", async () => {
    const broken: DecisionModel = {
      id: "broken",
      ask: async () => {
        throw new DecisionError("broken", "the probabilities add up to 1.7, not 1")
      },
    }

    const decision = await ask(broken)

    expect(decision.reason).toBe("fallback")
    expect(names(decision)).toEqual(SIX.map((t) => t.name))
  })

  test("ROUTE-5: a model that answers the wrong question is a fallback", async () => {
    const wrong: DecisionModel = {
      id: "wrong",
      ask: async () => ({ answers: {}, usage: { inputTokens: 1 } }),
    }

    const decision = await ask(wrong)

    expect(decision.reason).toBe("fallback")
    expect(decision.error).toMatch(/no answer/)
  })
})

describe("DM-3: more options than one choice can hold", () => {
  const many = (count: number): Tool[] =>
    Array.from({ length: count }, (_, i) => tool(`tool_${String(i).padStart(3, "0")}`))

  test("DM-3: 300 tools are asked in groups of at most 255, in one request", async () => {
    const tools = many(300)
    const model = scriptedDecisionModel([], { whenUnscripted: "default" })

    await route({
      decisionModel: model,
      tools,
      state: STATE,
      minTools: 5,
      threshold: 0.6,
      timeoutMs: 3000,
    })

    // DM-2 still holds for the groups: they are independent, so they go
    // together. Only the runoff has to wait for them.
    const asked = model.calls[0]?.questions ?? {}
    const groups = Object.values(asked)
    expect(groups.length).toBeGreaterThan(1)
    for (const question of groups) {
      const options = (question as { options: Record<string, string> }).options
      expect(Object.keys(options).length).toBeLessThanOrEqual(255)
      // Every group offers no_tool, so a group can say none of mine.
      expect(options[NO_TOOL]).toBeDefined()
    }
  })

  test("DM-3: every tool is offered exactly once across the groups", async () => {
    const tools = many(300)
    const model = scriptedDecisionModel([], { whenUnscripted: "default" })

    await route({
      decisionModel: model,
      tools,
      state: STATE,
      minTools: 5,
      threshold: 0.6,
      timeoutMs: 3000,
    })

    const offered: string[] = []
    for (const question of Object.values(model.calls[0]?.questions ?? {})) {
      for (const name of Object.keys((question as { options: object }).options)) {
        if (name !== NO_TOOL) offered.push(name)
      }
    }
    expect(offered.sort()).toEqual(tools.map((t) => t.name).sort())
  })

  test("DM-3: a second choice runs over the group winners", async () => {
    const tools = many(300)
    const groupNames = ["tool_group_0", "tool_group_1"]
    const model = scriptedDecisionModel([
      {
        [groupNames[0]!]: choice("tool_005", { tool_005: 0.8, [NO_TOOL]: 0.2 }),
        [groupNames[1]!]: choice("tool_260", { tool_260: 0.7, [NO_TOOL]: 0.3 }),
      },
      {
        [ROUTING_QUESTION]: choice("tool_260", {
          tool_260: 0.75,
          tool_005: 0.2,
          [NO_TOOL]: 0.05,
        }),
      },
    ])

    const decision = await route({
      decisionModel: model,
      tools,
      state: STATE,
      minTools: 5,
      threshold: 0.6,
      timeoutMs: 3000,
    })

    expect(model.calls).toHaveLength(2)
    expect(decision.requests).toBe(2)
    // The runoff only offers what the groups put forward.
    const runoff = model.calls[1]?.questions[ROUTING_QUESTION] as {
      options: Record<string, string>
    }
    expect(Object.keys(runoff.options).sort()).toEqual([NO_TOOL, "tool_005", "tool_260"].sort())
    expect(names(decision)[0]).toBe("tool_260")
  })

  test("DM-3: when every group says no_tool there is no runoff to run", async () => {
    const tools = many(300)
    const model = scriptedDecisionModel([
      {
        tool_group_0: choice(NO_TOOL, { [NO_TOOL]: 0.95, tool_005: 0.05 }),
        tool_group_1: choice(NO_TOOL, { [NO_TOOL]: 0.98, tool_260: 0.02 }),
      },
    ])

    const decision = await route({
      decisionModel: model,
      tools,
      state: STATE,
      minTools: 5,
      threshold: 0.6,
      timeoutMs: 3000,
    })

    expect(model.calls).toHaveLength(1)
    expect(decision.reason).toBe("no_tool")
    expect(decision.tools).toEqual([])
  })

  test("DM-3: one group naming a tool needs no runoff either", async () => {
    const tools = many(300)
    const model = scriptedDecisionModel([
      {
        tool_group_0: choice("tool_005", { tool_005: 0.9, [NO_TOOL]: 0.1 }),
        tool_group_1: choice(NO_TOOL, { [NO_TOOL]: 0.99, tool_260: 0.01 }),
      },
    ])

    const decision = await route({
      decisionModel: model,
      tools,
      state: STATE,
      minTools: 5,
      threshold: 0.6,
      timeoutMs: 3000,
    })

    expect(model.calls).toHaveLength(1)
    expect(names(decision)).toEqual(["tool_005"])
  })

  test("DM-3: a split that cannot be read falls back to every tool", async () => {
    const tools = many(300)
    const model = scriptedDecisionModel([{ throws: "down" }])

    const decision = await route({
      decisionModel: model,
      tools,
      state: STATE,
      minTools: 5,
      threshold: 0.6,
      timeoutMs: 3000,
    })

    expect(decision.reason).toBe("fallback")
    expect(decision.tools).toHaveLength(300)
  })

  test("DM-3: 255 options exactly is one question, since that is what fits", async () => {
    // 254 tools plus no_tool is 255, so no split is needed.
    const tools = many(254)
    const model = scriptedDecisionModel([], { whenUnscripted: "default" })

    await route({
      decisionModel: model,
      tools,
      state: STATE,
      minTools: 5,
      threshold: 0.6,
      timeoutMs: 3000,
    })

    expect(Object.keys(model.calls[0]?.questions ?? {})).toEqual([ROUTING_QUESTION])
  })
})

describe("BUILTIN-1: built in tools skip routing", () => {
  /**
   * A built in tool, as the core will build them.
   *
   * It cannot go through `defineTool`, because TOOL-2 refuses an agent
   * tool that takes a built in name. That rule is right, and it is why
   * this fixture names the tool after building it.
   */
  const builtin = (name: string): Tool => ({ ...tool(`stand_in_${name}`), name })
  const builtins = [builtin("remember"), builtin("escalate")]

  test("BUILTIN-1: a built in tool is never one of the routing options", async () => {
    const model = scriptedDecisionModel([{ [ROUTING_QUESTION]: choice("book") }])
    await ask(model, { builtins })

    const options = (
      model.calls[0]?.questions[ROUTING_QUESTION] as { options: Record<string, string> }
    ).options
    expect(options["remember"]).toBeUndefined()
    expect(options["escalate"]).toBeUndefined()
  })

  test("BUILTIN-1: built in tools are exposed even when no_tool wins", async () => {
    // The person must always be able to be escalated, whatever routing
    // thinks of the agent's own tools.
    const model = scriptedDecisionModel([
      { [ROUTING_QUESTION]: choice(NO_TOOL, { [NO_TOOL]: 0.99, book: 0.01 }) },
    ])

    const decision = await ask(model, { builtins })

    expect(decision.tools).toEqual([])
    expect(decision.builtins.map((t) => t.name)).toEqual(["remember", "escalate"])
    expect(decision.exposed.map((t) => t.name)).toEqual(["remember", "escalate"])
  })

  test("BUILTIN-1: built in tools come through a fallback too", async () => {
    const model = scriptedDecisionModel([{ throws: "down" }])

    const decision = await ask(model, { builtins })

    expect(decision.exposed.map((t) => t.name)).toEqual([
      "remember",
      "escalate",
      ...SIX.map((t) => t.name),
    ])
  })

  test("BUILTIN-1: built ins do not count towards the routing threshold", async () => {
    // Five agent tools and two built ins is five, not seven, so routing
    // stays off.
    const model = scriptedDecisionModel([{ [ROUTING_QUESTION]: choice("book") }])

    const decision = await route({
      decisionModel: model,
      tools: SIX.slice(0, 5),
      builtins,
      state: STATE,
      minTools: 5,
      threshold: 0.6,
      timeoutMs: 3000,
    })

    expect(decision.reason).toBe("not_routed")
    expect(model.calls).toHaveLength(0)
  })
})

describe("what routing reports back", () => {
  test("the decision carries what was decided, so a step can record it", async () => {
    const model = scriptedDecisionModel(
      [{ [ROUTING_QUESTION]: choice("book", { book: 0.95, read_menu: 0.05 }) }],
      { costUsd: 0.00002 },
    )

    const decision = await ask(model)

    expect(decision.choice).toBe("book")
    expect(decision.confidence).toBeCloseTo(0.95)
    expect(decision.probabilities).toEqual({ book: 0.95, read_menu: 0.05 })
    expect(decision.requests).toBe(1)
    expect(decision.costUsd).toBeCloseTo(0.00002)
  })

  test("a split adds up what both requests cost", async () => {
    const model = scriptedDecisionModel(
      [
        {
          tool_group_0: choice("tool_005", { tool_005: 0.8, [NO_TOOL]: 0.2 }),
          tool_group_1: choice("tool_260", { tool_260: 0.7, [NO_TOOL]: 0.3 }),
        },
        { [ROUTING_QUESTION]: choice("tool_260", { tool_260: 0.9, tool_005: 0.1 }) },
      ],
      { costUsd: 0.00003 },
    )

    const decision = await route({
      decisionModel: model,
      tools: Array.from({ length: 300 }, (_, i) => tool(`tool_${String(i).padStart(3, "0")}`)),
      state: STATE,
      minTools: 5,
      threshold: 0.6,
      timeoutMs: 3000,
    })

    expect(decision.costUsd).toBeCloseTo(0.00006)
  })

  test("not routing costs nothing and says so", async () => {
    const model = scriptedDecisionModel([])
    const decision = await route({
      decisionModel: model,
      tools: SIX.slice(0, 2),
      state: STATE,
      minTools: 5,
      threshold: 0.6,
      timeoutMs: 3000,
    })

    expect(decision.costUsd).toBe(0)
    expect(decision.confidence).toBeUndefined()
  })
})
