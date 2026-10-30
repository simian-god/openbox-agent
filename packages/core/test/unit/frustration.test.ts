// LEARN-1's frustration question, which is the one flag in the table that
// needs the decision model to be asked something new.
import { test, expect, describe } from "bun:test"
import {
  FRUSTRATION,
  FRUSTRATION_LEVELS,
  frustrationQuestion,
  isFrustrated,
} from "../../src/runtime/frustration.ts"
import type { Answer } from "../../src/providers/decision/types.ts"

describe("LEARN-1: the frustration question", () => {
  test("LEARN-1: it is a score over calm, annoyed and angry, in that order", () => {
    const question = frustrationQuestion()

    expect(question.type).toBe("score")
    // The order is the scale. Reversed, a calm person would score 2 and
    // every quiet conversation would be flagged.
    expect(question.levels).toEqual(["calm", "annoyed", "angry"])
  })

  test("LEARN-1: the scale runs 0 to 2, which is what the threshold is measured on", () => {
    expect(FRUSTRATION_LEVELS).toHaveLength(3)
    expect(FRUSTRATION_LEVELS.length - 1).toBe(2)
  })

  test("LEARN-1: the question asks how they sound, not what they want", () => {
    // HAND-1's `wants_human` rides in the same request and opens a
    // handover. This one only raises a flag, so if both asked the same
    // thing the agent would hand over every time somebody was annoyed.
    const instructions = frustrationQuestion().instructions.toLowerCase()

    expect(instructions).not.toContain("human being")
    expect(instructions).not.toContain("put through")
  })

  test("LEARN-1: every level says when it wins, so the model is not guessing", () => {
    const levels = frustrationQuestion().levels
    for (const level of levels) expect(level.length).toBeGreaterThan(0)
  })

  test("the question has a name of its own, because DM-2 sends it with the others", () => {
    expect(FRUSTRATION).toBe("frustration")
  })
})

describe("LEARN-1: at or above the threshold", () => {
  const at = (score: number, threshold = 1.5) =>
    isFrustrated({ type: "score", score, probabilities: {}, confidence: 1 }, threshold)

  test("LEARN-1: at the threshold is flagged, because the Spec says at or above", () => {
    expect(at(1.5)).toBe(true)
  })

  test("LEARN-1: above it is flagged", () => {
    expect(at(1.51)).toBe(true)
    expect(at(2)).toBe(true)
  })

  test("LEARN-1: below it is not", () => {
    expect(at(1.49)).toBe(false)
    expect(at(0)).toBe(false)
  })

  test("the threshold is read from config, not fixed at 1.5", () => {
    // A builder who finds 1.5 too noisy raises it. If this read the
    // default instead, that config line would do nothing.
    expect(at(1.2, 1.0)).toBe(true)
    expect(at(1.6, 1.8)).toBe(false)
  })

  test("an answer of another shape is not frustration, rather than a crash", () => {
    // The adapters are checked, but a decision model is somebody else's
    // code and this runs on the first step of every turn.
    expect(isFrustrated({ type: "yesno", p: 1 }, 1.5)).toBe(false)
    expect(isFrustrated(undefined, 1.5)).toBe(false)
  })

  test("a score on an answer that is not a score is still not frustration", () => {
    // The case the type check is actually for. Reading `.score` off
    // whatever arrives would pass this, because the number is there and
    // it is over the line: the shape has to be checked, not just the
    // field. Cast, because this is the shape TypeScript exists to stop
    // and a provider is somebody else's code.
    const wrong = { type: "yesno", p: 1, score: 2 } as unknown as Answer

    expect(isFrustrated(wrong, 1.5)).toBe(false)
  })
})
