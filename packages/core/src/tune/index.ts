// ROUTE-4 and LEARN-5: where the routing threshold should sit.
//
// The threshold is a dial between two costs. Above it the brain is shown
// the top few tools, which is cheaper and faster. Below it the brain is
// shown everything, which is safer and costs more. 0.6 is the Spec's
// starting value, not a measurement of anyone's agent.
//
// There is only one way narrowing can hurt. The model was confident, and
// the right tool was not among the few it showed. Call that a miss.
// Raising the threshold means fewer misses and less narrowing, so tuning
// is the question "how many misses buy the speed and the saving", and the
// answer is a number the builder chooses rather than one this file
// invents. `tolerance` is that number.
//
// Note what this does not do: it never asks the model the same question
// twice. One request per labeled example, the answer recorded, and then
// every candidate threshold measured against those recorded answers. A
// threshold changes what the core does with an answer, not the answer, so
// measuring 101 thresholds costs exactly as much as measuring one.
import { within, answerOf } from "../runtime/decide.ts"
import {
  NO_TOOL,
  ROUTING_QUESTION,
  routingQuestion,
  topTools,
  type Picked,
} from "../runtime/routing.ts"
import type { DecisionModel } from "../providers/decision/types.ts"
import type { Role, Tool } from "../tools/index.ts"
import { conversationKey, isPositive, type LabeledExample } from "./examples.ts"

export * from "./examples.ts"

/** The share of examples that may lose their tool. A builder's number. */
export const DEFAULT_TOLERANCE = 0.01

/**
 * Thresholds are measured on a grid of hundredths.
 *
 * Built as `step / 100` rather than `step * 0.01`, which is not the same
 * number: 70 * 0.01 is 0.7000000000000001, and a threshold that reads like
 * that in a config file is a threshold nobody trusts. It also quietly
 * changes the answer, since a confidence of exactly 0.7 falls on the other
 * side of it.
 */
const STEPS = 101

export interface TuneOptions {
  decisionModel: DecisionModel
  /** Every agent tool the project registers. */
  tools: Tool[]
  examples: LabeledExample[]
  /** config.decisionModel.routeThreshold, so the report can compare. */
  current: number
  /** The miss rate the recommendation will not exceed. */
  tolerance?: number | undefined
  /** config.decisionTimeoutMs. */
  timeoutMs: number
  /** Called as each example is answered, since this makes real requests. */
  onProgress?: ((done: number, total: number) => void) | undefined
}

/** What would happen on this labeled set at one threshold. */
export interface AtThreshold {
  threshold: number
  /** How many examples routing would narrow. */
  narrowed: number
  narrowRate: number
  /** Narrowed examples whose right tool was not shown. */
  misses: number
  missRate: number
  /** The average number of agent tools the brain would be shown. */
  meanExposed: number
}

/** One example, answered. Kept so a threshold can be re measured for free. */
export interface Answered {
  example: LabeledExample
  pick: Picked
  /** The tools that were offered as options, so topTools can be replayed. */
  offered: Tool[]
}

export interface TuneReport {
  /** Which decision model this is about. A threshold never carries over. */
  model: string
  examples: number
  positives: number
  negatives: number
  requests: number
  costUsd: number
  /** Examples that could not be answered at all, so were left out. */
  failures: { where: string; error: string }[]
  /**
   * C8's first bar: never a tool that does not exist. Both adapters
   * already refuse an answer naming an option they did not offer, so this
   * counts what got past that, which should always be zero.
   */
  invented: number
  /** How often the model's first choice was the labeled one. */
  topPickCorrect: number
  topPickRate: number
  /** A `shouldNot` example whose own tool was picked anyway. */
  pickedWarnedAgainst: number
  /** Every threshold from 0 to 1, so the report can show a curve. */
  curve: AtThreshold[]
  /** Where config sits now. */
  current: AtThreshold
  /** The lowest threshold inside the tolerance, if any reaches it. */
  recommended?: AtThreshold | undefined
  tolerance: number
}

/** The state routing reasons over, built from a labeled example (ROUTE-1). */
function stateOf(example: LabeledExample): unknown {
  return {
    messages: example.messages.slice(-6),
    batch: example.batch,
    activeTask: null,
  }
}

/** ROUTE-1: the options for one role, which is what the question holds. */
function toolsForRole(tools: Tool[], role: Role): Tool[] {
  return tools.filter((tool) => tool.roles.includes(role))
}

/**
 * Asks the model about every example, once.
 *
 * An example that cannot be answered is left out rather than counted as a
 * miss. A provider that was down says nothing about where a threshold
 * belongs, and folding an outage into an accuracy number would quietly
 * recommend a threshold tuned on a bad afternoon.
 */
export async function answerExamples(options: TuneOptions): Promise<{
  answered: Answered[]
  failures: { where: string; error: string }[]
  requests: number
  costUsd: number
}> {
  const { decisionModel, tools, examples, timeoutMs } = options
  const answered: Answered[] = []
  const failures: { where: string; error: string }[] = []
  let requests = 0
  let costUsd = 0

  const questions = new Map<
    Role,
    { offered: Tool[]; question: ReturnType<typeof routingQuestion> }
  >()
  const forRole = (role: Role) => {
    const made = questions.get(role)
    if (made !== undefined) return made
    const offered = toolsForRole(tools, role)
    const built = { offered, question: routingQuestion(offered) }
    questions.set(role, built)
    return built
  }

  // Two examples with the same conversation and the same role are the same
  // question: the options are the same and the state is the same, so only
  // the label differs. Asking twice would buy the same answer twice. This
  // is not a rare case either: a tool's `shouldNot` examples are often
  // ordinary greetings, and every tool lists some.
  const asked = new Map<string, Picked>()

  for (const [index, example] of examples.entries()) {
    const { offered, question } = forRole(example.role)
    const key = conversationKey(example)

    const already = asked.get(key)
    if (already !== undefined) {
      answered.push({ example, pick: already, offered })
      options.onProgress?.(index + 1, examples.length)
      continue
    }

    try {
      const result = await within(
        (signal) =>
          decisionModel.ask(stateOf(example), { [ROUTING_QUESTION]: question }, { signal }),
        timeoutMs,
      )
      requests++
      costUsd += result.usage.costUsd ?? 0
      const answer = answerOf(result.answers, ROUTING_QUESTION, "choice")
      const pick: Picked = {
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      }
      asked.set(key, pick)
      answered.push({ example, pick, offered })
    } catch (error) {
      requests++
      failures.push({
        where: example.where,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    options.onProgress?.(index + 1, examples.length)
  }

  return { answered, failures, requests, costUsd }
}

/**
 * What this labeled set would do at one threshold.
 *
 * ROUTE-2's rules exactly, including `topTools`, which is the production
 * function rather than a copy of it. A tuner that measured its own idea of
 * exposure would recommend a threshold for an agent nobody is running.
 */
export function measureAt(answered: Answered[], threshold: number): AtThreshold {
  let narrowed = 0
  let misses = 0
  let exposedTotal = 0

  for (const { example, pick, offered } of answered) {
    // ROUTE-2: below the threshold the brain sees every tool the role
    // allows, so the right tool is always reachable and there is nothing
    // routing could have cost.
    if (pick.confidence < threshold) {
      exposedTotal += offered.length
      continue
    }

    narrowed++
    const shown = pick.choice === NO_TOOL ? [] : topTools(pick, offered)
    exposedTotal += shown.length

    // A negative example rules one tool out and names no replacement, so
    // it cannot say whether the right tool was shown. It is measured
    // separately.
    if (!isPositive(example)) continue

    // A labeled `no_tool` cannot be missed. Routing showing a tool the
    // brain did not need costs a few tokens; it cannot make the brain
    // call it, and the brain can still answer from the conversation.
    if (example.tool === NO_TOOL) continue

    if (!shown.some((tool) => tool.name === example.tool)) misses++
  }

  const total = answered.length
  return {
    threshold,
    narrowed,
    narrowRate: total === 0 ? 0 : narrowed / total,
    misses,
    missRate: total === 0 ? 0 : misses / total,
    meanExposed: total === 0 ? 0 : exposedTotal / total,
  }
}

export async function tune(options: TuneOptions): Promise<TuneReport> {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE
  const { answered, failures, requests, costUsd } = await answerExamples(options)

  let topPickCorrect = 0
  let pickedWarnedAgainst = 0
  let invented = 0
  let positives = 0
  let negatives = 0

  for (const { example, pick, offered } of answered) {
    const names = new Set(offered.map((tool) => tool.name))
    if (pick.choice !== NO_TOOL && !names.has(pick.choice)) invented++

    if (isPositive(example)) {
      positives++
      if (pick.choice === example.tool) topPickCorrect++
    } else {
      negatives++
      if (pick.choice === example.notTool) pickedWarnedAgainst++
    }
  }

  const curve = Array.from({ length: STEPS }, (_, step) => measureAt(answered, step / 100))

  // The lowest threshold inside the tolerance. Lowest, because every step
  // up is a turn that pays full price for a tool list it did not need.
  const recommended = curve.find((at) => at.missRate <= tolerance)

  return {
    model: options.decisionModel.id,
    examples: answered.length,
    positives,
    negatives,
    requests,
    costUsd,
    failures,
    invented,
    topPickCorrect,
    topPickRate: positives === 0 ? 0 : topPickCorrect / positives,
    pickedWarnedAgainst,
    curve,
    current: measureAt(answered, options.current),
    ...(recommended !== undefined ? { recommended } : {}),
    tolerance,
  }
}
