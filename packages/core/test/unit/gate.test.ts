// GATE-1 to GATE-5: whether a write or an irreversible call may run.
//
// The gate is the one piece of this core that decides whether something
// happens in the world, so the rule that matters most here is GATE-4: when
// the decision model cannot answer, nothing runs. Every other safety claim
// in the Spec rests on that, routing's licence to fail open included.
//
// So the tests below are written to bite. Several of them exist only to
// prove a mistake would be caught: a band read the wrong way round, a
// failure treated as a low score, an irreversible call let through on a
// confident yes.
import { test, expect, describe } from "bun:test"
import { z } from "zod"
import {
  gate,
  gateQuestion,
  gateState,
  bandFor,
  isGated,
  DEFAULT_BANDS,
  GATE_QUESTION,
  GATE_INSTRUCTIONS,
  type Band,
  type GateDecision,
} from "../../src/runtime/gate.ts"
import { defineTool, type Risk, type Tool } from "../../src/tools/index.ts"
import { scriptedDecisionModel, yesno, choice } from "../../src/testing/scripted-decision.ts"
import type { DecisionModel } from "../../src/providers/decision/types.ts"

function tool(name: string, risk: Risk = "write"): Tool {
  return defineTool({
    name,
    description: `The ${name} tool.`,
    input: z.object({ size: z.number().int() }),
    risk,
    roles: ["end_user"],
    conditions: {
      callWhen: [`the person has agreed to ${name}`, "a party size is known"],
      dontCallWhen: [`the person is only asking about ${name}`],
    },
    examples: { should: [`do ${name}`], shouldNot: ["hello"] },
    ...(risk === "irreversible" ? { confirmSummary: () => `${name}?` } : {}),
    handler: async () => ({ ok: true }),
  })
}

const BOOK = tool("book_table")
const CHARGE = tool("charge_card", "irreversible")
const MENU = tool("read_menu", "read")

const CONVERSATION = {
  messages: [
    { role: "person", text: "a table for four on Monday please" },
    { role: "agent", text: "I can do 19:00." },
    { role: "person", text: "yes, book it" },
  ],
  activeTask: null,
}

const ask = (
  model: DecisionModel,
  over: Partial<Parameters<typeof gate>[0]> = {},
): Promise<GateDecision> =>
  gate({
    decisionModel: model,
    tool: BOOK,
    args: { size: 4 },
    conversation: CONVERSATION,
    timeoutMs: 3000,
    ...over,
  })

/** A model that answers one probability, however it is asked. */
const says = (p: number): DecisionModel => scriptedDecisionModel([{ [GATE_QUESTION]: yesno(p) }])

describe("GATE-1: what the decision model is asked", () => {
  test("GATE-1: one yes/no question, worded as the Spec words it", async () => {
    const model = scriptedDecisionModel([{ [GATE_QUESTION]: yesno(0.9) }])
    await ask(model)

    const questions = model.calls[0]?.questions ?? {}
    expect(Object.keys(questions)).toEqual([GATE_QUESTION])
    expect(questions[GATE_QUESTION]?.type).toBe("yesno")
    expect(questions[GATE_QUESTION]?.instructions).toBe(GATE_INSTRUCTIONS)
  })

  test("GATE-1: the question says what a yes and a no each mean", async () => {
    // A yes/no with no criteria is answered against whatever the model
    // imagines the question was. Both adapters send these.
    const question = gateQuestion()

    expect(question.whenTrue).toContain("call when")
    expect(question.whenFalse).toContain("don't call when")
  })

  test("GATE-1: the state holds the conditions, the arguments and the conversation", async () => {
    const model = scriptedDecisionModel([{ [GATE_QUESTION]: yesno(0.9) }])
    await ask(model)

    expect(model.calls[0]?.state).toEqual({
      tool: "book_table",
      description: "The book_table tool.",
      conditions: {
        callWhen: ["the person has agreed to book_table", "a party size is known"],
        dontCallWhen: ["the person is only asking about book_table"],
      },
      args: { size: 4 },
      messages: CONVERSATION.messages,
      activeTask: null,
    })
  })

  test("GATE-1: the proposed arguments are in the state, not just the tool's name", async () => {
    // Without the arguments the question is unanswerable: a booking for
    // four at 19:00 and a booking for forty are the same tool.
    const state = gateState(BOOK, { size: 40 }, CONVERSATION)

    expect(state.args).toEqual({ size: 40 })
  })
})

describe("GATE-2: the bands", () => {
  test("GATE-2: a write passes at 0.7 and above", async () => {
    expect((await ask(says(0.7))).outcome).toBe("run")
    expect((await ask(says(0.95))).outcome).toBe("run")
  })

  test("GATE-2: a write between 0.4 and 0.7 needs a confirmation", async () => {
    const decision = await ask(says(0.55))

    expect(decision.outcome).toBe("confirm")
    expect(decision.reason).toBe("confirm")
  })

  test("GATE-2: a write below 0.4 is blocked", async () => {
    const decision = await ask(says(0.39))

    expect(decision.outcome).toBe("block")
    expect(decision.reason).toBe("block")
  })

  test("GATE-2: the floors are inclusive, as the Spec's table writes them", async () => {
    // p >= 0.7 passes and p >= 0.4 confirms. Written as a test because an
    // off by one here is the difference between asking and acting.
    expect((await ask(says(0.7))).outcome).toBe("run")
    expect((await ask(says(0.6999))).outcome).toBe("confirm")
    expect((await ask(says(0.4))).outcome).toBe("confirm")
    expect((await ask(says(0.3999))).outcome).toBe("block")
  })

  test("GATE-2: an irreversible call sits on higher floors", async () => {
    expect(DEFAULT_BANDS.irreversible).toEqual({ pass: 0.85, confirm: 0.5 })
    // 0.8 passes for a write and does not for an irreversible call.
    expect((await ask(says(0.8))).outcome).toBe("run")
    const risky = await ask(says(0.8), { tool: CHARGE })
    expect(risky.reason).toBe("confirm")
  })

  test("GATE-2: a band can be overridden per tool", async () => {
    const strict: Record<string, Band> = { book_table: { pass: 0.99, confirm: 0.98 } }
    // 0.985 would run on the default band and does not on this one.
    const decision = await ask(says(0.985), { bands: strict })

    expect(decision.outcome).toBe("confirm")
    expect(decision.band).toEqual({ pass: 0.99, confirm: 0.98 })
  })

  test("GATE-2: an override is per tool, so other tools keep their defaults", async () => {
    const strict: Record<string, Band> = { something_else: { pass: 0.99, confirm: 0.98 } }

    expect(bandFor(BOOK, strict)).toEqual(DEFAULT_BANDS.write)
    expect(bandFor(CHARGE, strict)).toEqual(DEFAULT_BANDS.irreversible)
    expect((await ask(says(0.8), { bands: strict })).outcome).toBe("run")
  })

  test("GATE-2: the band it was measured against is reported, so a trace can be read", async () => {
    const decision = await ask(says(0.55))

    expect(decision.p).toBe(0.55)
    expect(decision.band).toEqual({ pass: 0.7, confirm: 0.4 })
  })

  test("GATE-2: a confirm quotes the tool's conditions", async () => {
    const decision = await ask(says(0.55))

    expect(decision.message).toContain("confirm")
    expect(decision.message).toContain("the person has agreed to book_table")
    expect(decision.message).toContain("the person is only asking about book_table")
  })

  test("GATE-2: a block tells the brain it is blocked and not to retry it", async () => {
    const decision = await ask(says(0.1))

    expect(decision.message).toContain("blocked")
    expect(decision.message).toContain("did not run")
    expect(decision.message).toContain("Do not call it again")
  })

  test("GATE-2: a call that runs is told nothing, because there is nothing to say", async () => {
    const decision = await ask(says(0.9))

    expect(decision.message).toBeUndefined()
  })
})

describe("GATE-4: failing closed", () => {
  test("GATE-4: a decision model that is down means a write is not run", async () => {
    const down = scriptedDecisionModel([{ throws: "the provider is down", retryable: true }])
    const decision = await ask(down)

    expect(decision.outcome).toBe("confirm")
    expect(decision.reason).toBe("failed_closed")
    expect(decision.error).toMatch(/the provider is down/)
  })

  test("GATE-4: an outage is a Confirm, not a Block", async () => {
    // A Block tells the brain the call is wrong. Nothing here supports
    // that: the model did not say no, it said nothing. Telling the person
    // their request was refused because a vendor was down would be a lie
    // the brain had no way to catch.
    const down = scriptedDecisionModel([{ throws: "502" }])
    const decision = await ask(down)

    expect(decision.outcome).not.toBe("block")
    expect(decision.message).toContain("confirm")
  })

  test("GATE-4: a timeout fails closed too, within decisionTimeoutMs", async () => {
    const slow: DecisionModel = {
      id: "slow",
      ask: () => new Promise(() => {}),
    }

    const started = Date.now()
    const decision = await ask(slow, { timeoutMs: 50 })

    expect(decision.reason).toBe("failed_closed")
    expect(decision.outcome).toBe("confirm")
    expect(decision.error).toMatch(/50/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("GATE-4: an answer to the wrong question fails closed", async () => {
    // A model that answers something else has not answered this. Reading
    // whatever came back would be the one mistake this file exists to stop.
    const wrong: DecisionModel = {
      id: "wrong",
      ask: async () => ({ answers: {}, usage: { inputTokens: 1 } }),
    }

    const decision = await ask(wrong)

    expect(decision.reason).toBe("failed_closed")
    expect(decision.error).toMatch(/no answer/)
  })

  test("GATE-4: an answer of the wrong kind fails closed", async () => {
    // A choice where a probability was asked for. `confidence` on it would
    // read as a plausible number, which is exactly why it is refused.
    const confident = scriptedDecisionModel([{ [GATE_QUESTION]: choice("yes") }])
    const decision = await ask(confident)

    expect(decision.reason).toBe("failed_closed")
    expect(decision.error).toMatch(/choice/)
  })

  test("GATE-4: an irreversible call is never run on a confident yes", async () => {
    // CONF-1's structured confirm never depends on the decision model. A
    // 1.0 is still not permission to charge someone's card.
    const decision = await ask(says(1), { tool: CHARGE })

    expect(decision.outcome).toBe("confirm")
    expect(decision.reason).toBe("needs_confirm")
    expect(decision.message).toContain("cannot be undone")
  })

  test("GATE-4: an unscripted question is a 0, which blocks", async () => {
    // The scripted model's most boring answer. A test that forgot to
    // script the gate must not pass because the fake was generous.
    const empty = scriptedDecisionModel([{}])
    const decision = await ask(empty)

    expect(decision.outcome).toBe("block")
  })
})

describe("GATE-5: read tools are never gated", () => {
  test("GATE-5: a read tool runs without being asked about", async () => {
    const model = scriptedDecisionModel([{ [GATE_QUESTION]: yesno(0) }])
    const decision = await ask(model, { tool: MENU })

    expect(decision.outcome).toBe("run")
    expect(decision.reason).toBe("not_gated")
    // The point: no request was made at all, so a read tool costs nothing
    // and cannot be stopped by a decision model being down.
    expect(model.calls).toHaveLength(0)
    expect(decision.requests).toBe(0)
  })

  test("GATE-5: the risk levels the gate applies to", () => {
    expect(isGated("read")).toBe(false)
    expect(isGated("write")).toBe(true)
    expect(isGated("irreversible")).toBe(true)
  })

  test("GATE-5: a read tool is unaffected by a decision model that is down", async () => {
    const down = scriptedDecisionModel([{ throws: "the provider is down" }])
    const decision = await ask(down, { tool: MENU })

    expect(decision.outcome).toBe("run")
  })
})

describe("the gate reports what it cost", () => {
  test("DM-1: one request, and its cost, so a turn can add it up", async () => {
    const model = scriptedDecisionModel([{ [GATE_QUESTION]: yesno(0.9) }], { costUsd: 0.00004 })
    const decision = await ask(model)

    expect(decision.requests).toBe(1)
    expect(decision.costUsd).toBeCloseTo(0.00004)
  })

  test("DM-1: the answer is passed through, so the decisions table holds it", async () => {
    const decision = await ask(says(0.55))

    expect(decision.answers?.[GATE_QUESTION]).toEqual({ type: "yesno", p: 0.55 })
  })

  test("a request that was made and failed is still a request that was paid for", async () => {
    const down = scriptedDecisionModel([{ throws: "502" }])

    expect((await ask(down)).requests).toBe(1)
  })
})
