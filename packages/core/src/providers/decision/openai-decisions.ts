// DM-1: the OpenAI Decisions API.
//
// Spec section 23 listed this one as "in beta, and only secondary sources
// were read", so it was checked against OpenAI's own documentation before
// any of it was built on, on 2026-10-21. What the docs say:
//
//   POST https://api.openai.com/v1/decisions
//   model gpt-6-luna, the only one it serves today
//   Authorization: Bearer, and the usual OpenAI error envelope
//
// It is a different wire shape from Jev in almost every respect, and
// absorbing that is the whole job of this file:
//
//   questions are an array, each carrying its own `name`, not a map
//   a choice offers `choices: [{ value, description }]`
//   a score offers `levels: [{ label, description }]`, lowest first
//   a predicate takes no criteria, so the Spec's whenTrue and whenFalse go
//     into the instructions rather than being thrown away
//   answers are an array, matched back by name and never by position
//   probabilities are arrays of objects rather than a map
//   `input` takes text, so a state that is not a string is written out
//   a question can come back with type "refusal", which no other route has
//
// Two things the docs do not say, and so this code cannot assume: there is
// no documented usage object, and there are no documented limits on the
// number of questions, choices or levels. Usage is read if it is sent and
// reported as nothing if it is not (docs/Known.md K9).
import type { FetchLike } from "../http.ts"
import type { Answer, DecisionModel, DecisionResult, DecisionUsage, Question } from "./types.ts"
import {
  decisionFail,
  readChoice,
  readConfidence,
  readProbability,
  readScore,
  readSpread,
} from "./validate.ts"

const ID = "openai-decisions"
const DEFAULT_URL = "https://api.openai.com/v1/decisions"

/** The only model the endpoint serves. Pinnable, since it is in beta. */
const DEFAULT_MODEL = "gpt-6-luna"

/**
 * A 429 means two different things here and only the body tells them
 * apart: a rate limit, which clears on its own, or credit that has run
 * out, which never does. Retrying the second burns the backoff for
 * nothing, so these codes are read as final.
 */
const OUT_OF_CREDIT = [
  "credit_balance_exhausted",
  "insufficient_quota",
  "billing_hard_limit_reached",
  "billing_not_active",
  "account_deactivated",
]

export interface OpenaiDecisionsOptions {
  apiKey: string
  /** Overrides the default model. */
  model?: string | undefined
  baseUrl?: string | undefined
  /** Injected so contract tests run without network (TEST-3). */
  fetch?: FetchLike | undefined
  /** Sent as the OpenAI-Organization and OpenAI-Project headers. */
  organization?: string | undefined
  project?: string | undefined
}

/** A question in this API's own shape. */
type WireQuestion =
  | {
      type: "choice"
      name: string
      instructions: string
      choices: { value: string; description?: string }[]
    }
  | {
      type: "score"
      name: string
      instructions: string
      levels: { label: string; description?: string }[]
    }
  | { type: "predicate"; name: string; instructions: string }

const fail = (message: string, retryable = false) => decisionFail(ID, message, retryable)

/**
 * A predicate carries no criteria, so guidance the builder wrote for the
 * true and false cases is folded into the instructions. Dropping it would
 * quietly make this route worse than Jev at the very same question.
 */
function predicateInstructions(question: Extract<Question, { type: "yesno" }>): string {
  const parts = [question.instructions]
  if (question.whenTrue !== undefined) parts.push(`True when: ${question.whenTrue}.`)
  if (question.whenFalse !== undefined) parts.push(`False when: ${question.whenFalse}.`)
  return parts.join(" ")
}

/** The Spec's Question onto this API's own. */
function toWire(name: string, question: Question): WireQuestion {
  switch (question.type) {
    case "choice": {
      const entries = Object.entries(question.options)
      if (entries.length === 0) throw fail(`question ${name}: a choice with no options`)
      return {
        type: "choice",
        name,
        instructions: question.instructions,
        // A null description is left out rather than sent as null: the
        // option's own name is the explanation in that case.
        choices: entries.map(([value, description]) => ({
          value,
          ...(description !== null ? { description } : {}),
        })),
      }
    }
    case "score": {
      if (question.levels.length < 2) {
        throw fail(`question ${name}: a score needs at least two levels to sit between`)
      }
      return {
        type: "score",
        name,
        instructions: question.instructions,
        levels: question.levels.map((label) => ({ label })),
      }
    }
    case "yesno":
      return { type: "predicate", name, instructions: predicateInstructions(question) }
  }
}

/** `[{ value, probability }]` onto the spread the Spec asks for. */
function spreadFromList(name: string, raw: unknown): Record<string, number> {
  if (!Array.isArray(raw)) {
    throw fail(`question ${name}: the answer carried no probabilities`)
  }
  const entries = raw.map((entry, index): [string, unknown] => {
    const row = entry as { value?: unknown; probability?: unknown }
    if (row.value === undefined || row.value === null) {
      throw fail(`question ${name}: probability ${index} names no option`)
    }
    return [String(row.value), row.probability]
  })
  return readSpread(ID, name, entries)
}

/** One answer, checked against the question it was asked for. */
function readAnswer(name: string, question: Question, raw: unknown): Answer {
  if (raw === undefined || raw === null) {
    throw fail(`question ${name}: no answer came back for it`)
  }
  const answer = raw as Record<string, unknown>

  // Unique to this route. A refusal must never read as a low probability:
  // GATE-4 fails closed on an outage, and a 0 would look like a confident
  // no. The same input would be refused again, so it is not retryable.
  if (answer["type"] === "refusal") {
    throw fail(`question ${name}: the model refused to answer it`)
  }

  switch (question.type) {
    case "choice": {
      if (answer["type"] !== "choice") {
        throw fail(`question ${name}: asked for a choice, answered with ${String(answer["type"])}`)
      }
      const probabilities = spreadFromList(name, answer["probabilities"])
      return {
        type: "choice",
        choice: readChoice(ID, name, answer["choice"], question.options),
        probabilities,
        confidence: readConfidence(ID, name, answer["confidence"], probabilities),
      }
    }

    case "score": {
      if (answer["type"] !== "score") {
        throw fail(`question ${name}: asked for a score, answered with ${String(answer["type"])}`)
      }
      // Keyed by the level index, exactly as the other route keys it, so
      // nothing downstream has to know which provider answered.
      const probabilities = spreadFromList(name, answer["probabilities"])
      return {
        type: "score",
        score: readScore(ID, name, answer["score"], question.levels),
        probabilities,
        confidence: readConfidence(ID, name, answer["confidence"], probabilities),
      }
    }

    case "yesno": {
      if (answer["type"] !== "predicate") {
        throw fail(
          `question ${name}: asked for a predicate, answered with ${String(answer["type"])}`,
        )
      }
      return { type: "yesno", p: readProbability(ID, name, "probability", answer["probability"]) }
    }
  }
}

interface DecisionsResponse {
  answers?: unknown
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null
  error?: { message?: string; type?: string; code?: string } | null
}

export function openaiDecisionsModel(options: OpenaiDecisionsOptions): DecisionModel {
  const call = options.fetch ?? globalThis.fetch
  const url = (options.baseUrl ?? DEFAULT_URL).replace(/\/+$/, "")
  const model = options.model ?? DEFAULT_MODEL

  return {
    id: ID,

    async ask(
      state: unknown,
      questions: Record<string, Question>,
      asking?: { signal?: AbortSignal | undefined },
    ): Promise<DecisionResult> {
      const names = Object.keys(questions)
      if (names.length === 0) {
        throw fail("a step asked no questions, so there is nothing to decide")
      }

      // Mapped first, so a question this API would refuse never costs
      // anything.
      const wire = names.map((name) => toWire(name, questions[name]!))

      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      }
      if (options.organization !== undefined) headers["OpenAI-Organization"] = options.organization
      if (options.project !== undefined) headers["OpenAI-Project"] = options.project

      let response: Response
      try {
        response = await call(url, {
          method: "POST",
          headers,
          // DM-2: the input once, every question beside it. `input` takes
          // text, so a state that is not already a string is written out.
          body: JSON.stringify({
            model,
            input: typeof state === "string" ? state : JSON.stringify(state),
            questions: wire,
          }),
          // K10: a request given up on is cancelled rather than left in
          // flight, where it was still billed and still holding a socket.
          ...(asking?.signal !== undefined ? { signal: asking.signal } : {}),
        })
      } catch (error) {
        throw fail(`request failed: ${String(error)}`, true)
      }

      const text = await response.text().catch(() => "")
      let payload: DecisionsResponse
      try {
        payload = JSON.parse(text) as DecisionsResponse
      } catch {
        if (!response.ok) {
          throw fail(
            `HTTP ${response.status}: ${text.slice(0, 300)}`,
            retryableStatus(response.status),
          )
        }
        // A 200 that is not JSON is almost always an edge or proxy page.
        throw fail(`the response was not JSON: ${text.slice(0, 300)}`, true)
      }

      if (!response.ok || payload.error) {
        const problem = payload.error
        const code = problem?.code ?? ""
        const detail = [problem?.message ?? text.slice(0, 300), code]
          .filter((part) => part !== "")
          .join(" ")
        const retryable = OUT_OF_CREDIT.includes(code) === false && retryableStatus(response.status)
        throw fail(`HTTP ${response.status}: ${detail}`, retryable)
      }

      if (!Array.isArray(payload.answers)) {
        throw fail("the response held no answers")
      }

      // Matched by name, never by position: the docs promise a name on
      // every answer and say nothing about the order they arrive in.
      const byName = new Map<string, unknown>()
      for (const answer of payload.answers) {
        const name = (answer as { name?: unknown }).name
        if (typeof name === "string") byName.set(name, answer)
      }

      const answers: Record<string, Answer> = {}
      for (const name of names) {
        answers[name] = readAnswer(name, questions[name]!, byName.get(name))
      }

      // These docs describe no usage object. Billing is per input token, so
      // one probably exists, but nothing here may depend on it (K9).
      const usage: DecisionUsage = { inputTokens: payload.usage?.input_tokens ?? 0 }

      return { answers, usage }
    },
  }
}

/** 408, 429 and 5xx are worth another attempt. A 4xx is our own mistake. */
const retryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500
