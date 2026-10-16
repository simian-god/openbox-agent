// TEST-3: the core's own suite runs without network, on a scripted brain.
// Exported for agent builders too, so their tests need no API key either.
import type { Brain, BrainInput, BrainOutput } from "../providers/brains/types.ts"
import { BrainError } from "../providers/brains/types.ts"

/** One scripted answer. Either a reply, or a tool to call. */
export type ScriptedStep =
  | { reply: string }
  | { tool: string; input?: unknown }
  | { throws: string; retryable?: boolean }
  /** Full control, for a case the shorthands do not cover. */
  | { output: BrainOutput }

export interface ScriptedBrainOptions {
  id?: string
  supportsImages?: boolean
  /**
   * What to answer when the script runs out. Repeating the last step suits
   * a loop test; the default is a plain reply so a test cannot hang.
   */
  whenExhausted?: "repeat-last" | "reply" | "throw"
  exhaustedReply?: string
}

export interface ScriptedBrain extends Brain {
  /** Every call made, in order, so a test can assert on what was sent. */
  readonly calls: BrainInput[]
  /** Queue more steps mid test. */
  push(...steps: ScriptedStep[]): void
  reset(): void
}

const outputFor = (step: ScriptedStep, id: string): BrainOutput => {
  if ("output" in step) return step.output

  if ("throws" in step) {
    throw new BrainError(id, step.throws, step.retryable ?? false)
  }

  if ("reply" in step) {
    return {
      text: step.reply,
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    }
  }

  return {
    toolCalls: [{ id: `call_${step.tool}`, name: step.tool, input: step.input ?? {} }],
    finishReason: "tool_calls",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  }
}

/**
 * A brain that answers from a list instead of a model.
 *
 *   const brain = scriptedBrain([{ tool: "create_booking" }, { reply: "Booked." }])
 */
export function scriptedBrain(
  script: ScriptedStep[] = [],
  options: ScriptedBrainOptions = {},
): ScriptedBrain {
  const id = options.id ?? "scripted"
  const whenExhausted = options.whenExhausted ?? "reply"
  const steps = [...script]
  const calls: BrainInput[] = []
  let next = 0

  return {
    id,
    kind: "api",
    supportsImages: options.supportsImages ?? true,
    calls,

    push(...more: ScriptedStep[]) {
      steps.push(...more)
    },

    reset() {
      steps.length = 0
      calls.length = 0
      next = 0
    },

    async complete(input: BrainInput): Promise<BrainOutput> {
      calls.push(input)

      const step = steps[next]
      if (step !== undefined) {
        next++
        return outputFor(step, id)
      }

      if (whenExhausted === "repeat-last") {
        const last = steps[steps.length - 1]
        if (last !== undefined) return outputFor(last, id)
      }
      if (whenExhausted === "throw") {
        throw new BrainError(id, `the script ran out after ${calls.length} calls`)
      }

      return {
        text: options.exhaustedReply ?? "(the scripted brain has nothing left to say)",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      }
    },
  }
}
