// What makes an answer trustworthy, in one place.
//
// Every decision adapter reads a different wire shape, but they all have to
// agree on when an answer may be believed: the spread adds up, every
// probability is in range, and a choice is one that was actually offered.
// That rule is safety critical, because GATE-4 fails closed on an outage
// and cannot do that if a broken answer arrives looking like a confident
// one. So it lives here and is tested here, not once per vendor.
//
// The scripted model holds its fixtures to the same rule on a tighter
// tolerance, since a fixture is written by hand rather than rounded by a
// provider.
import { DecisionError, confidenceOf } from "./types.ts"

/**
 * How far a spread may be from adding up to 1 before it is refused.
 *
 * A provider rounds the numbers it sends, so a little slack is right.
 * Normalising a spread that is properly wrong would hide a broken answer,
 * so anything past this is an error rather than something to fix up.
 */
export const MASS_TOLERANCE = 0.05

export const decisionFail = (id: string, message: string, retryable = false): DecisionError =>
  new DecisionError(id, message, retryable)

/** One probability, in range. Used for a bare yes or no answer. */
export function readProbability(id: string, name: string, what: string, raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw decisionFail(id, `question ${name}: the ${what} is not a number`)
  }
  if (raw < 0 || raw > 1) {
    throw decisionFail(id, `question ${name}: the ${what} is ${raw}, not between 0 and 1`)
  }
  return raw
}

/** A spread of probabilities, checked before anything is read off it. */
export function readSpread(
  id: string,
  name: string,
  entries: [string, unknown][],
): Record<string, number> {
  if (entries.length === 0) {
    throw decisionFail(id, `question ${name}: the answer carried no probabilities`)
  }

  const spread: Record<string, number> = {}
  let total = 0
  for (const [key, value] of entries) {
    if (key in spread) {
      throw decisionFail(id, `question ${name}: the probability for ${key} came back twice`)
    }
    const p = readProbability(id, name, `probability for ${key}`, value)
    spread[key] = p
    total += p
  }

  if (Math.abs(total - 1) > MASS_TOLERANCE) {
    throw decisionFail(id, `question ${name}: the probabilities add up to ${total}, not 1`)
  }
  return spread
}

/** A spread that arrived as an object, which is how most routes send one. */
export function readSpreadObject(id: string, name: string, raw: unknown): Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw decisionFail(id, `question ${name}: the answer carried no probabilities`)
  }
  return readSpread(id, name, Object.entries(raw as Record<string, unknown>))
}

/** The provider's own confidence when it sent one, the spread's otherwise. */
export function readConfidence(
  id: string,
  name: string,
  raw: unknown,
  spread: Record<string, number>,
): number {
  if (raw === undefined || raw === null) return confidenceOf(spread)
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw decisionFail(id, `question ${name}: the confidence is not a number`)
  }
  if (raw < 0 || raw > 1) {
    throw decisionFail(id, `question ${name}: the confidence is ${raw}, not between 0 and 1`)
  }
  return raw
}

/** A choice has to be for something that was offered. */
export function readChoice(
  id: string,
  name: string,
  raw: unknown,
  options: Record<string, string | null>,
): string {
  if (typeof raw !== "string") {
    throw decisionFail(id, `question ${name}: the choice is not a name`)
  }
  if (!(raw in options)) {
    throw decisionFail(
      id,
      `question ${name}: ${raw} is not one of the options (${Object.keys(options).join(", ")})`,
    )
  }
  return raw
}

/**
 * A score is the spread's expected level on every route that sends one, so
 * it cannot sit outside the levels that were offered.
 */
export function readScore(id: string, name: string, raw: unknown, levels: string[]): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw decisionFail(id, `question ${name}: the score is not a number`)
  }
  const highest = levels.length - 1
  if (raw < 0 || raw > highest + MASS_TOLERANCE) {
    throw decisionFail(
      id,
      `question ${name}: the score is ${raw}, and the levels only reach ${highest}`,
    )
  }
  return raw
}
