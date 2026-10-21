// TEST-3: the core's own suite runs on a scripted decision model, with no
// network and no key. Exported for agent builders too, whose tests need the
// same thing.
//
// A fake that the gate rests on has to be unambiguous, so this one is
// deliberately unhelpful in two ways:
//
//   A question it has no answer for gets the most boring answer there is,
//   never a flattering one: the first option, the lowest level, zero. A
//   test that forgot to script something must not pass because the fake
//   was generous.
//
//   A fixture that cannot be true is refused when it is written, not when
//   it is read. Probabilities that do not add up, or a choice for an option
//   that was not offered, are a test proving nothing.
import {
  DecisionError,
  confidenceOf,
  type Answer,
  type DecisionModel,
  type DecisionResult,
  type Question,
} from "../providers/decision/types.ts"

export type { Question, Answer }

const ADDS_UP = 0.001

function checkSpread(probabilities: Record<string, number>, what: string): void {
  const total = Object.values(probabilities).reduce((sum, p) => sum + p, 0)
  if (Math.abs(total - 1) > ADDS_UP) {
    throw new Error(`${what}: the probabilities must add up to 1, these add up to ${total}`)
  }
  for (const [name, p] of Object.entries(probabilities)) {
    if (p < 0 || p > 1) throw new Error(`${what}: ${name} is ${p}, which is not between 0 and 1`)
  }
}

/** A scripted choice. The spread defaults to certainty. */
export function choice(
  picked: string,
  probabilities?: Record<string, number>,
  confidence?: number,
): Extract<Answer, { type: "choice" }> {
  const spread = probabilities ?? { [picked]: 1 }
  checkSpread(spread, `choice ${picked}`)
  return {
    type: "choice",
    choice: picked,
    probabilities: spread,
    confidence: confidence ?? confidenceOf(spread),
  }
}

/** A scripted score. The spread defaults to certainty at that level. */
export function score(
  level: number,
  probabilities?: Record<string, number>,
  confidence?: number,
): Extract<Answer, { type: "score" }> {
  const spread = probabilities ?? { [String(level)]: 1 }
  checkSpread(spread, `score ${level}`)
  return {
    type: "score",
    score: level,
    probabilities: spread,
    confidence: confidence ?? confidenceOf(spread),
  }
}

/** A scripted yes or no, as the one probability the Spec asks for. */
export function yesno(p: number): Extract<Answer, { type: "yesno" }> {
  if (p < 0 || p > 1) throw new Error(`yesno: ${p} is not between 0 and 1`)
  return { type: "yesno", p }
}

/** One scripted step: an answer per question, or an outage. */
export type ScriptedAnswers =
  | Record<string, Answer>
  | { throws: string; retryable?: boolean | undefined }

export interface ScriptedDecisionOptions {
  id?: string
  costUsd?: number | undefined
  /**
   * What to do with a question the step does not answer. The boring
   * default, or refuse, for a test that wants to prove it scripted
   * everything that was asked.
   */
  whenUnscripted?: "default" | "throw"
  /** What to do once the script runs out. Repeating cannot hang a test. */
  whenExhausted?: "repeat-last" | "throw"
}

export interface ScriptedDecisionModel extends DecisionModel {
  /** Every request made, so a test can assert on what was asked. */
  readonly calls: { state: unknown; questions: Record<string, Question> }[]
  push(...steps: ScriptedAnswers[]): void
  reset(): void
}

const isOutage = (step: ScriptedAnswers): step is { throws: string; retryable?: boolean } =>
  typeof (step as { throws?: unknown }).throws === "string"

/** The most boring answer a question can have. */
function boring(name: string, question: Question): Answer {
  if (question.type === "choice") {
    const first = Object.keys(question.options)[0]
    if (first === undefined) throw new Error(`question ${name}: a choice with no options`)
    return choice(first)
  }
  if (question.type === "score") return score(0)
  return yesno(0)
}

export function scriptedDecisionModel(
  script: ScriptedAnswers[] = [],
  options: ScriptedDecisionOptions = {},
): ScriptedDecisionModel {
  const id = options.id ?? "scripted"
  const whenUnscripted = options.whenUnscripted ?? "default"
  const whenExhausted = options.whenExhausted ?? "repeat-last"
  const steps = [...script]
  const calls: { state: unknown; questions: Record<string, Question> }[] = []
  let next = 0

  return {
    id,
    calls,

    push(...more: ScriptedAnswers[]) {
      steps.push(...more)
    },

    reset() {
      steps.length = 0
      calls.length = 0
      next = 0
    },

    async ask(state: unknown, questions: Record<string, Question>): Promise<DecisionResult> {
      // Recorded before anything can throw, so a test can see what was
      // asked even when the answer was an outage.
      calls.push({ state, questions })

      let step = steps[next]
      if (step !== undefined) next++
      else if (whenExhausted === "repeat-last") step = steps[steps.length - 1]

      if (step === undefined) {
        throw new DecisionError(id, `the script ran out after ${calls.length} requests`)
      }
      if (isOutage(step)) throw new DecisionError(id, step.throws, step.retryable ?? false)

      // Narrowed once: past the outage check, a step is an answer map.
      const answered = step as Record<string, Answer>

      const answers: Record<string, Answer> = {}
      for (const [name, question] of Object.entries(questions)) {
        const scripted = answered[name]
        if (scripted === undefined) {
          if (whenUnscripted === "throw") {
            throw new DecisionError(id, `question ${name} is not scripted`)
          }
          answers[name] = boring(name, question)
          continue
        }

        // A choice has to be for something that was offered, or the test
        // is asserting on an answer the real model could never give.
        if (scripted.type === "choice" && question.type === "choice") {
          if (!(scripted.choice in question.options)) {
            throw new DecisionError(
              id,
              `question ${name}: ${scripted.choice} is not one of the options (${Object.keys(question.options).join(", ")})`,
            )
          }
        }
        answers[name] = scripted
      }

      return {
        answers,
        usage: {
          inputTokens: JSON.stringify(state).length,
          ...(options.costUsd !== undefined ? { costUsd: options.costUsd } : {}),
        },
      }
    },
  }
}
