// GATE-1 to GATE-5: whether a write or an irreversible call may run.
//
// This is the opposite of routing in every way that matters. Routing is an
// optimisation, so it fails open: when it cannot decide, the brain sees
// every tool. The gate decides whether something happens in the world, so
// it fails closed: when it cannot decide, nothing runs (GATE-4). Routing
// is only allowed to fail open because this file fails closed.
//
// The decision model never decides anything here either. It answers one
// yes/no question with one probability, and the band that probability
// falls into is what decides (GATE-2). That separation is what lets a
// threshold be tuned without touching the safety logic: move a band and
// the worst that happens is more confirmations.
//
// Nothing here touches the database or records an event. It answers with
// what it decided, and the step records that, which is what lets every
// rule below be tested without a turn.
import type { Answer, DecisionModel, DecisionUsage, Question } from "../providers/decision/types.ts"
import type { Risk, Tool } from "../tools/index.ts"
import { answerOf, within } from "./decide.ts"

/** The question's name, so a step and its tests agree on it. */
export const GATE_QUESTION = "gate"

/** GATE-1's question, as the Spec words it. */
export const GATE_INSTRUCTIONS =
  "This call meets the tool's call when conditions and none of its don't call when conditions, given the conversation."

/** GATE-2: the two floors of a band. */
export interface Band {
  /** At or above this, the call passes. */
  pass: number
  /** At or above this but below `pass`, it needs a confirmation. */
  confirm: number
}

/**
 * GATE-2's defaults. An irreversible call sits higher on both floors,
 * because the cost of running one that should not have run cannot be
 * undone, and the cost of asking the person first is a sentence.
 */
export const DEFAULT_BANDS: Record<"write" | "irreversible", Band> = {
  write: { pass: 0.7, confirm: 0.4 },
  irreversible: { pass: 0.85, confirm: 0.5 },
}

/**
 * The band for one tool: the default for its risk, unless config names
 * this tool (`decisionModel.gateBands`, which is per decision model, since
 * two models do not spread their probabilities the same way).
 */
export function bandFor(tool: Tool, overrides: Record<string, Band> = {}): Band {
  const named = overrides[tool.name]
  if (named !== undefined) return named
  return tool.risk === "irreversible" ? DEFAULT_BANDS.irreversible : DEFAULT_BANDS.write
}

/** GATE-1: the last 6 messages and the active task. */
export interface GateConversation {
  messages: { role: string; text: string }[]
  /** M4 fills this in. Null until tasks exist. */
  activeTask: unknown
}

/** GATE-1: everything the question is answered against. */
export interface GateState {
  tool: string
  description: string
  conditions: { callWhen: string[]; dontCallWhen: string[] }
  /** The arguments the brain proposed, after the schema accepted them. */
  args: unknown
  messages: { role: string; text: string }[]
  activeTask: unknown
}

export interface GateOptions {
  decisionModel: DecisionModel
  tool: Tool
  /** LOOP-8 step 6 has already validated these. */
  args: unknown
  conversation: GateConversation
  /** config.decisionModel.gateBands, keyed by tool name. */
  bands?: Record<string, Band> | undefined
  /** config.decisionTimeoutMs. A timeout is a failure, so it fails closed. */
  timeoutMs: number
  /** LIMIT-3: what the call cost, when the provider did not say. */
  price?: ((usage: DecisionUsage) => number) | undefined
}

export interface GateDecision {
  /** What happens to the call. The only thing the step has to obey. */
  outcome: "run" | "confirm" | "block"
  /**
   * `not_gated`     a read tool, never gated (GATE-5)
   * `pass`          above the Pass floor, and reversible, so it runs
   * `needs_confirm` passed, but irreversible, so it needs a structured confirm
   * `confirm`       in the Confirm band
   * `block`         below the Confirm floor
   * `failed_closed` no usable answer, so it is treated as Confirm (GATE-4)
   */
  reason: "not_gated" | "pass" | "needs_confirm" | "confirm" | "block" | "failed_closed"
  /** The probability the question came back with, when there was one. */
  p?: number | undefined
  /** The band it was measured against. Absent for a read tool. */
  band?: Band | undefined
  /** What the brain is told. Absent when the call runs. */
  message?: string | undefined
  /** Why it failed closed, when it did. */
  error?: string | undefined
  /** The answer as the adapter returned it, for the decisions table. */
  answers?: Record<string, Answer> | undefined
  /** Decision requests made. One, or none for a read tool. */
  requests: number
  costUsd: number
}

/** GATE-1: the yes/no question for one proposed call. */
export function gateQuestion(): Extract<Question, { type: "yesno" }> {
  return {
    type: "yesno",
    instructions: GATE_INSTRUCTIONS,
    whenTrue:
      "The proposed call meets every one of the tool's call when conditions, and none of its don't call when conditions apply.",
    whenFalse:
      "A call when condition is not met, or a don't call when condition applies, or the conversation does not show enough to tell.",
  }
}

export function gateState(tool: Tool, args: unknown, conversation: GateConversation): GateState {
  return {
    tool: tool.name,
    description: tool.description,
    conditions: {
      callWhen: [...tool.conditions.callWhen],
      dontCallWhen: [...tool.conditions.dontCallWhen],
    },
    args,
    messages: conversation.messages,
    activeTask: conversation.activeTask,
  }
}

/**
 * The conditions, written out for the brain.
 *
 * GATE-2 asks for the condition in doubt to be quoted. One yes/no question
 * gives one probability, so there is no way to tell which condition the
 * model doubted, and every condition is quoted instead (docs/Known.md
 * K12). Quoting all of them is more use than quoting none, and guessing at
 * one would be an invention dressed as a reason.
 */
function conditionsFor(tool: Tool): string {
  const lines = [
    ...tool.conditions.callWhen.map((line) => `- call when: ${line}`),
    ...tool.conditions.dontCallWhen.map((line) => `- don't call when: ${line}`),
  ]
  return `The conditions it was judged against:\n${lines.join("\n")}`
}

const confirmMessage = (tool: Tool): string =>
  [
    `${tool.name} was not run. It is not certain enough that this call fits the tool's conditions, so the person has to confirm it first.`,
    "Ask the person to confirm, saying plainly what you are about to do. Do not say it is done.",
    conditionsFor(tool),
  ].join("\n\n")

/** An irreversible call that passed. CONF-1's pending action is M4. */
const pendingMessage = (tool: Tool): string =>
  [
    `${tool.name} cannot be undone, so it is never run without the person's confirmation. It has not run.`,
    "A confirmation is being asked for. Tell the person what is being confirmed, and do not say the action is done.",
  ].join("\n\n")

const blockMessage = (tool: Tool): string =>
  [
    `${tool.name} was blocked and did not run. Given this conversation it does not meet the tool's conditions.`,
    "Do not call it again until the person has given something new that changes that. Answer them, or ask for what is missing.",
    conditionsFor(tool),
  ].join("\n\n")

const failedClosedMessage = (tool: Tool): string =>
  [
    `${tool.name} was not run. The check that decides whether a call like this is safe could not be made, so it is being treated as needing confirmation.`,
    "Ask the person to confirm, saying plainly what you are about to do. Do not say it is done.",
  ].join("\n\n")

/** True for the risk levels the gate applies to (GATE-5). */
export const isGated = (risk: Risk): boolean => risk !== "read"

export async function gate(options: GateOptions): Promise<GateDecision> {
  const { decisionModel, tool, args, conversation, timeoutMs } = options
  const price = options.price ?? ((usage: DecisionUsage): number => usage.costUsd ?? 0)

  // GATE-5: a read tool is never gated, and no request is made for it.
  // Reading at the wrong moment is harmless, and ROLE-3 already decides
  // who may read what.
  if (!isGated(tool.risk)) {
    return { outcome: "run", reason: "not_gated", requests: 0, costUsd: 0 }
  }

  const band = bandFor(tool, options.bands)

  let p: number
  let answers: Record<string, Answer>
  let costUsd = 0
  try {
    const result = await within(
      decisionModel.ask(gateState(tool, args, conversation), { [GATE_QUESTION]: gateQuestion() }),
      timeoutMs,
    )
    costUsd = price(result.usage)
    answers = result.answers
    p = answerOf(result.answers, GATE_QUESTION, "yesno").p
  } catch (error) {
    // GATE-4: fail closed. A write is treated as Confirm, and so is an
    // irreversible call, which needs a structured confirm regardless and
    // so never depended on this answer in the first place.
    //
    // Deliberately not a Block. A Block tells the brain the call is wrong,
    // which would be a claim about the conversation that nothing here
    // supports: the model did not say no, it said nothing.
    return {
      outcome: "confirm",
      reason: "failed_closed",
      band,
      message: failedClosedMessage(tool),
      error: error instanceof Error ? error.message : String(error),
      requests: 1,
      costUsd,
    }
  }

  // GATE-2, in the Spec's own order. Note the floors are inclusive, as its
  // table writes them: p >= pass passes, p >= confirm confirms.
  if (p >= band.pass) {
    return tool.risk === "irreversible"
      ? {
          outcome: "confirm",
          reason: "needs_confirm",
          p,
          band,
          message: pendingMessage(tool),
          answers,
          requests: 1,
          costUsd,
        }
      : { outcome: "run", reason: "pass", p, band, answers, requests: 1, costUsd }
  }

  if (p >= band.confirm) {
    return {
      outcome: "confirm",
      reason: "confirm",
      p,
      band,
      message: confirmMessage(tool),
      answers,
      requests: 1,
      costUsd,
    }
  }

  return {
    outcome: "block",
    reason: "block",
    p,
    band,
    message: blockMessage(tool),
    answers,
    requests: 1,
    costUsd,
  }
}
