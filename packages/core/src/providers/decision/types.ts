// The DecisionModel from Spec section 4.
//
// A decision model answers questions about a conversation with
// probabilities, not with prose. That is the whole reason it is a separate
// dependency from the brain: routing and the gate need a number they can
// put a threshold on, and a sentence is not a number.
//
// Three question types, because three is what every adapter can map onto
// its vendor's own (DM-1): Jev's choice, score and noul, OpenAI's choice,
// score and predicate.
//
// The model never decides anything. It says how likely; the gate decides
// where the line is (section 8). Keeping those apart is what lets a
// threshold be tuned without touching the safety logic.

/** What the core asks about one step. */
export type Question =
  | {
      type: "choice"
      instructions: string
      /**
       * The options, each with the conditions that should make it win, or
       * null when its name is explanation enough.
       */
      options: Record<string, string | null>
    }
  | { type: "score"; instructions: string; levels: string[] }
  | { type: "yesno"; instructions: string; whenTrue?: string; whenFalse?: string }

/** What comes back. Every form carries how sure it is. */
export type Answer =
  | {
      type: "choice"
      choice: string
      probabilities: Record<string, number>
      confidence: number
    }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number }
  /** One probability, deliberately: the caller decides what to do with it. */
  | { type: "yesno"; p: number }

export interface DecisionUsage {
  inputTokens: number
  costUsd?: number | undefined
}

export interface DecisionRequest {
  /** Whatever the caller wants the model to reason over. */
  state: unknown
  /** DM-2: every question for this step, in one request. */
  questions: Record<string, Question>
}

export interface DecisionResult {
  answers: Record<string, Answer>
  usage: DecisionUsage
}

export interface DecisionModel {
  id: string
  /**
   * DM-2: all the questions for one step, in one request, so the state is
   * paid for once.
   */
  ask(state: unknown, questions: Record<string, Question>): Promise<DecisionResult>
}

/**
 * A decision model that could not answer.
 *
 * Its own type, because the gate has to tell an outage apart from an
 * answer: GATE-4 fails closed when the model is down, and it cannot do
 * that if a failure arrives looking like a low score.
 */
export class DecisionError extends Error {
  readonly id: string
  readonly retryable: boolean

  constructor(id: string, message: string, retryable = false) {
    super(`decision model ${id}: ${message}`)
    this.name = "DecisionError"
    this.id = id
    this.retryable = retryable
  }
}

/** The highest probability in a spread, which is what confidence means. */
export function confidenceOf(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities)
  return values.length === 0 ? 0 : Math.max(...values)
}
