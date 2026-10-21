// DM-1: Jev, TypeSafe's decision model, on both routes it is published on.
//
// Checked against the real documentation on 2026-10-21 (TypeSafe's own API
// reference, OpenRouter's Decisions API reference and its Jev guide). Both
// routes take the same body and answer with the same shape, so one adapter
// serves both and only the URL, the key and the model id differ.
//
// What the vendor calls things is not what the Spec calls them, and that
// mapping is the whole job of this file:
//
//   our yesno      is Jev's noul, answered as a bare probability of yes
//   our options    is Jev's criteria, as an option map, at most 255
//   our levels     is Jev's criteria, as an ordered array of 2 to 10
//   our confidence is Jev's own confidence, which is NOT the top
//                  probability: the docs are explicit that it describes
//                  the whole distribution. The gate thresholds on it
//                  (T3.5), so it is passed through rather than recomputed.
//
// Jev's score is an expected level and comes back fractional (1.89 over
// three levels). That fraction is kept: rounding it is the caller's
// decision, not the adapter's.
//
// Two documented limits are checked here, before a request is paid for,
// because the API answers both with a 4xx: a choice takes at most 255
// options, and a score takes 2 to 10 levels.
import type { FetchLike } from "../http.ts"
import {
  DecisionError,
  confidenceOf,
  type Answer,
  type DecisionModel,
  type DecisionResult,
  type DecisionUsage,
  type Question,
} from "./types.ts"

const ID = "jev"

/** The two routes DM-1 names. */
export const JEV_ROUTES = ["typesafe", "openrouter"] as const
export type JevRoute = (typeof JEV_ROUTES)[number]

/**
 * Where each route lives and what it calls the model.
 *
 * Both default models are pinned rather than an alias. The OpenRouter
 * endpoint is alpha and the native API is in early access, so a floating
 * `jev-latest` could change the contract under a running agent.
 */
const ROUTES: Record<JevRoute, { url: string; model: string }> = {
  typesafe: { url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" },
  openrouter: { url: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.14" },
}

/** Jev's documented limits. */
const MAX_OPTIONS = 255
const MIN_LEVELS = 2
const MAX_LEVELS = 10

/**
 * How far a spread may be from adding up to 1 before it is refused. The
 * vendor rounds what it sends, so a little slack is right; normalising a
 * spread that is properly wrong would hide a broken answer.
 */
const MASS_TOLERANCE = 0.05

export interface JevOptions {
  apiKey: string
  /**
   * Named, never guessed. Posting a TypeSafe key to OpenRouter would hand
   * a credential to a third party, so there is no default to get wrong.
   */
  route: JevRoute
  /** Overrides the pinned default for that route. */
  model?: string | undefined
  baseUrl?: string | undefined
  /** Injected so contract tests run without network (TEST-3). */
  fetch?: FetchLike | undefined
  /** OpenRouter shows these on its activity page. Ignored on TypeSafe. */
  appUrl?: string | undefined
  appName?: string | undefined
}

/** A question in Jev's own shape. */
type WireQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }

const fail = (message: string, retryable = false): DecisionError =>
  new DecisionError(ID, message, retryable)

/** The Spec's Question onto Jev's own, refusing what Jev would refuse. */
function toWire(name: string, question: Question): WireQuestion {
  switch (question.type) {
    case "choice": {
      const criteria = question.options
      const count = Object.keys(criteria).length
      if (count === 0) throw fail(`question ${name}: a choice with no options`)
      if (count > MAX_OPTIONS) {
        throw fail(
          `question ${name}: ${count} options, and Jev takes at most ${MAX_OPTIONS}. DM-3 splits a larger choice into groups before it gets here`,
        )
      }
      return { type: "choice", instructions: question.instructions, criteria }
    }
    case "score": {
      const criteria = question.levels
      if (criteria.length < MIN_LEVELS || criteria.length > MAX_LEVELS) {
        throw fail(
          `question ${name}: ${criteria.length} levels, and Jev takes between ${MIN_LEVELS} and ${MAX_LEVELS}`,
        )
      }
      return { type: "score", instructions: question.instructions, criteria }
    }
    case "yesno":
      // OpenRouter's reference makes noul's criteria required, with both a
      // true and a false key, while the Spec's whenTrue and whenFalse are
      // optional. Filling them in keeps one body valid on both routes.
      return {
        type: "noul",
        instructions: question.instructions,
        criteria: {
          true: question.whenTrue ?? "the statement in the instructions is true of this state",
          false:
            question.whenFalse ?? "the statement in the instructions is not true of this state",
        },
      }
  }
}

/** A spread, checked before anything is read off it. */
function readSpread(name: string, raw: unknown): Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw fail(`question ${name}: the answer carried no probabilities`)
  }

  const spread: Record<string, number> = {}
  let total = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw fail(`question ${name}: the probability for ${key} is not a number`)
    }
    if (value < 0 || value > 1) {
      throw fail(`question ${name}: the probability for ${key} is ${value}, not between 0 and 1`)
    }
    spread[key] = value
    total += value
  }

  if (Object.keys(spread).length === 0) {
    throw fail(`question ${name}: the answer carried an empty spread`)
  }
  if (Math.abs(total - 1) > MASS_TOLERANCE) {
    throw fail(`question ${name}: the probabilities add up to ${total}, not 1`)
  }
  return spread
}

/** The vendor's confidence when it sent one, the spread's own otherwise. */
function readConfidence(name: string, raw: unknown, spread: Record<string, number>): number {
  if (raw === undefined || raw === null) return confidenceOf(spread)
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw fail(`question ${name}: the confidence is not a number`)
  }
  if (raw < 0 || raw > 1) {
    throw fail(`question ${name}: the confidence is ${raw}, not between 0 and 1`)
  }
  return raw
}

/** One answer, checked against the question it was asked for. */
function readAnswer(name: string, question: Question, raw: unknown): Answer {
  if (raw === undefined || raw === null) {
    throw fail(`question ${name}: no answer came back for it`)
  }
  const answer = raw as Record<string, unknown>

  switch (question.type) {
    case "choice": {
      if (answer["type"] !== "choice") {
        throw fail(`question ${name}: asked for a choice, answered with ${String(answer["type"])}`)
      }
      const probabilities = readSpread(name, answer["probabilities"])
      const picked = answer["choice"]
      if (typeof picked !== "string") throw fail(`question ${name}: the choice is not a name`)
      if (!(picked in question.options)) {
        throw fail(
          `question ${name}: ${picked} is not one of the options (${Object.keys(question.options).join(", ")})`,
        )
      }
      return {
        type: "choice",
        choice: picked,
        probabilities,
        confidence: readConfidence(name, answer["confidence"], probabilities),
      }
    }

    case "score": {
      if (answer["type"] !== "score") {
        throw fail(`question ${name}: asked for a score, answered with ${String(answer["type"])}`)
      }
      const probabilities = readSpread(name, answer["probabilities"])
      const score = answer["score"]
      if (typeof score !== "number" || !Number.isFinite(score)) {
        throw fail(`question ${name}: the score is not a number`)
      }
      // Jev's score is the spread's expected level, so it cannot sit
      // outside the levels that were offered.
      const highest = question.levels.length - 1
      if (score < 0 || score > highest + MASS_TOLERANCE) {
        throw fail(`question ${name}: the score is ${score}, and the levels only reach ${highest}`)
      }
      return {
        type: "score",
        score,
        probabilities,
        confidence: readConfidence(name, answer["confidence"], probabilities),
      }
    }

    case "yesno": {
      if (answer["type"] !== "noul") {
        throw fail(`question ${name}: asked for a noul, answered with ${String(answer["type"])}`)
      }
      const p = answer["noul"]
      if (typeof p !== "number" || !Number.isFinite(p)) {
        throw fail(`question ${name}: the noul is not a number`)
      }
      if (p < 0 || p > 1) {
        throw fail(`question ${name}: the noul is ${p}, not between 0 and 1`)
      }
      return { type: "yesno", p }
    }
  }
}

/** What the response envelope looks like on both routes. */
interface JevResponse {
  answers?: Record<string, unknown> | null
  model?: string
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number } | null
  error?: { code?: number; message?: string } | null
}

/** 408, 429 and 5xx are worth another attempt. A 4xx is our own mistake. */
const worthRetrying = (status: number): boolean => status === 408 || status === 429 || status >= 500

export function jevDecisionModel(options: JevOptions): DecisionModel {
  const route = ROUTES[options.route]
  if (route === undefined) {
    throw fail(`route ${String(options.route)} is not one of ${JEV_ROUTES.join(", ")}`)
  }

  const call = options.fetch ?? globalThis.fetch
  const url = (options.baseUrl ?? route.url).replace(/\/+$/, "")
  const model = options.model ?? route.model

  return {
    id: ID,

    async ask(state: unknown, questions: Record<string, Question>): Promise<DecisionResult> {
      const names = Object.keys(questions)
      if (names.length === 0) {
        throw fail("a step asked no questions, so there is nothing to decide")
      }

      // Mapped first, so a question Jev would refuse never costs anything.
      const wire: Record<string, WireQuestion> = {}
      for (const name of names) wire[name] = toWire(name, questions[name]!)

      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      }
      if (options.route === "openrouter") {
        if (options.appUrl !== undefined) headers["HTTP-Referer"] = options.appUrl
        if (options.appName !== undefined) headers["X-Title"] = options.appName
      }

      let response: Response
      try {
        response = await call(url, {
          method: "POST",
          headers,
          // DM-2: the state once, every question beside it.
          body: JSON.stringify({ model, state, questions: wire }),
        })
      } catch (error) {
        throw fail(`request failed: ${String(error)}`, true)
      }

      const text = await response.text().catch(() => "")
      let payload: JevResponse
      try {
        payload = JSON.parse(text) as JevResponse
      } catch {
        if (!response.ok) {
          throw fail(
            `HTTP ${response.status}: ${text.slice(0, 300)}`,
            worthRetrying(response.status),
          )
        }
        // A 200 that is not JSON is almost always an edge or proxy page.
        throw fail(`the response was not JSON: ${text.slice(0, 300)}`, true)
      }

      if (!response.ok) {
        const detail = payload.error?.message ?? text.slice(0, 300)
        throw fail(`HTTP ${response.status}: ${detail}`, worthRetrying(response.status))
      }
      if (payload.error) {
        throw fail(payload.error.message ?? "the route reported an error", true)
      }

      const answers: Record<string, Answer> = {}
      for (const name of names) {
        answers[name] = readAnswer(name, questions[name]!, payload.answers?.[name])
      }

      // Output tokens are free on both routes, so the Spec's usage has no
      // slot for them.
      const usage: DecisionUsage = {
        inputTokens: payload.usage?.input_tokens ?? 0,
        ...(typeof payload.usage?.cost === "number" ? { costUsd: payload.usage.cost } : {}),
      }

      return { answers, usage }
    },
  }
}
