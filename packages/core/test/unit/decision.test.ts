// DM-2 and TEST-3: the decision model interface, and a scripted one.
//
// The decision model is what the gate will rest on, so the fake has to be
// unambiguous: a test must never pass because the fake guessed kindly. It
// records every question it was asked, and a question it has no answer for
// is answered in one documented, boring way rather than a flattering one.
import { test, expect, describe } from "bun:test"
import { scriptedDecisionModel, choice, score, yesno } from "../../src/testing/scripted-decision.ts"
import { DecisionError, type Answer, type Question } from "../../src/providers/decision/types.ts"

const QUESTIONS: Record<string, Question> = {
  route: {
    type: "choice",
    instructions: "Which tool answers this?",
    options: { check_availability: "the person asks about a table", read_menu: null },
  },
  frustration: {
    type: "score",
    instructions: "How annoyed?",
    levels: ["calm", "annoyed", "angry"],
  },
  wants_human: { type: "yesno", instructions: "Do they want a person?" },
}

const only = (name: keyof typeof QUESTIONS): Record<string, Question> => ({
  [name]: QUESTIONS[name]!,
})

describe("DM-2: one request per step", () => {
  test("DM-2: every question for a step is asked in one call", async () => {
    // The whole point of the shape: the state is paid for once.
    const model = scriptedDecisionModel([
      { route: choice("check_availability"), frustration: score(0), wants_human: yesno(0.1) },
    ])

    const { answers } = await model.ask({ messages: ["any space on Monday?"] }, QUESTIONS)

    expect(model.calls).toHaveLength(1)
    expect(Object.keys(model.calls[0]?.questions ?? {}).sort()).toEqual([
      "frustration",
      "route",
      "wants_human",
    ])
    expect(Object.keys(answers).sort()).toEqual(["frustration", "route", "wants_human"])
  })

  test("DM-2: the state it was given is recorded, so a test can read it", async () => {
    const model = scriptedDecisionModel([{ wants_human: yesno(0) }])
    await model.ask({ person: "p1", said: "hello" }, only("wants_human"))

    expect(model.calls[0]?.state).toEqual({ person: "p1", said: "hello" })
  })

  test("DM-2: usage is reported, because a step is paid for", async () => {
    const model = scriptedDecisionModel([{ wants_human: yesno(0) }], { costUsd: 0.0004 })
    const { usage } = await model.ask({}, only("wants_human"))

    expect(usage.costUsd).toBe(0.0004)
    expect(usage.inputTokens).toBeGreaterThanOrEqual(0)
  })
})

describe("the answers have the shape the Spec gives", () => {
  test("a choice carries the winner, the spread and a confidence", async () => {
    const model = scriptedDecisionModel([
      { route: choice("read_menu", { read_menu: 0.7, check_availability: 0.3 }) },
    ])
    const { answers } = await model.ask({}, only("route"))
    const answer = answers["route"] as Extract<Answer, { type: "choice" }>

    expect(answer.type).toBe("choice")
    expect(answer.choice).toBe("read_menu")
    expect(answer.probabilities).toEqual({ read_menu: 0.7, check_availability: 0.3 })
    // Confidence is the winner's own probability unless it is given.
    expect(answer.confidence).toBeCloseTo(0.7)
  })

  test("a choice with no spread given is certain", async () => {
    const model = scriptedDecisionModel([{ route: choice("read_menu") }])
    const { answers } = await model.ask({}, only("route"))
    const answer = answers["route"] as Extract<Answer, { type: "choice" }>

    expect(answer.probabilities).toEqual({ read_menu: 1 })
    expect(answer.confidence).toBe(1)
  })

  test("a score carries the level, the spread and a confidence", async () => {
    const model = scriptedDecisionModel([{ frustration: score(2, { 0: 0.1, 1: 0.2, 2: 0.7 }) }])
    const { answers } = await model.ask({}, only("frustration"))
    const answer = answers["frustration"] as Extract<Answer, { type: "score" }>

    expect(answer.score).toBe(2)
    expect(answer.confidence).toBeCloseTo(0.7)
  })

  test("a yes or no is one probability, not a verdict", async () => {
    // The gate decides where the line is; the model only says how likely.
    const model = scriptedDecisionModel([{ wants_human: yesno(0.83) }])
    const { answers } = await model.ask({}, only("wants_human"))

    expect(answers["wants_human"]).toEqual({ type: "yesno", p: 0.83 })
  })

  test("a fixture whose probabilities do not add up is refused", () => {
    // A bad fixture is a test that proves nothing, so it fails loudly here
    // rather than quietly later.
    expect(() => choice("a", { a: 0.6, b: 0.6 })).toThrow(/add up/)
    expect(() => score(0, { 0: 0.2, 1: 0.2 })).toThrow(/add up/)
    expect(() => yesno(1.4)).toThrow(/between 0 and 1/)
  })

  test("a choice for an option that was not offered is refused", async () => {
    const model = scriptedDecisionModel([{ route: choice("no_such_tool") }])

    await expect(model.ask({}, only("route"))).rejects.toThrow(/not one of the options/)
  })
})

describe("what the fake does when the script does not cover something", () => {
  test("it answers an unscripted question in one boring way", async () => {
    // Not a flattering one. A choice takes the first option, a score the
    // lowest level, a yes or no zero, so a test that forgot to script
    // something does not pass because the fake was generous.
    const model = scriptedDecisionModel([{}])
    const { answers } = await model.ask({}, QUESTIONS)

    expect((answers["route"] as { choice: string }).choice).toBe("check_availability")
    expect((answers["frustration"] as { score: number }).score).toBe(0)
    expect((answers["wants_human"] as { p: number }).p).toBe(0)
    // And the test can still see it was asked.
    expect(Object.keys(model.calls[0]?.questions ?? {})).toContain("route")
  })

  test("it can be made to refuse an unscripted question instead", async () => {
    const model = scriptedDecisionModel([{}], { whenUnscripted: "throw" })

    await expect(model.ask({}, only("route"))).rejects.toThrow(/not scripted/)
  })

  test("each call takes the next answer set", async () => {
    const model = scriptedDecisionModel([
      { route: choice("check_availability") },
      { route: choice("read_menu") },
    ])

    const first = await model.ask({}, only("route"))
    const second = await model.ask({}, only("route"))

    expect((first.answers["route"] as { choice: string }).choice).toBe("check_availability")
    expect((second.answers["route"] as { choice: string }).choice).toBe("read_menu")
  })

  test("past the end it repeats the last set, so a loop test cannot hang", async () => {
    const model = scriptedDecisionModel([{ route: choice("read_menu") }])

    await model.ask({}, only("route"))
    const again = await model.ask({}, only("route"))

    expect((again.answers["route"] as { choice: string }).choice).toBe("read_menu")
    expect(model.calls).toHaveLength(2)
  })

  test("it can be made to throw past the end, for a test about an outage", async () => {
    const model = scriptedDecisionModel([{ wants_human: yesno(0) }], { whenExhausted: "throw" })

    await model.ask({}, only("wants_human"))
    await expect(model.ask({}, only("wants_human"))).rejects.toThrow(DecisionError)
  })

  test("a scripted outage is a DecisionError, saying whether it is worth retrying", async () => {
    // GATE-4 will fail closed on an outage, so the gate has to be able to
    // tell an outage from an answer.
    const model = scriptedDecisionModel([{ throws: "the provider is down", retryable: true }])

    const error = await model
      .ask({}, only("wants_human"))
      .then(() => null)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DecisionError)
    expect((error as DecisionError).retryable).toBe(true)
    expect((error as DecisionError).id).toBe("scripted")
  })
})

test("TEST-3: the scripted model reaches nothing outside the process", () => {
  // A plain object with no client and no fetch, which is what lets the
  // core's own suite run with no network and no key.
  const model = scriptedDecisionModel([])
  expect(model.id).toBe("scripted")
  expect(typeof model.ask).toBe("function")
})
