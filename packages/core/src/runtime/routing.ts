// ROUTE-1 to ROUTE-5, DM-3 and BUILTIN-1: which tools the brain is shown.
//
// Routing keeps a large agent's tool list short enough for the brain to
// choose well. It is an optimisation, and that is the whole shape of this
// file: an optimisation that is not sure of itself must not remove the
// right answer.
//
// So routing narrows only when the decision model is confident. Below the
// threshold the brain sees every tool the role allows (ROUTE-2), and when
// the decision model fails or is slow the step carries on with every tool
// (ROUTE-5). Routing is the one place in the core that fails open, and it
// can only do that because the gate decides whether a call actually runs.
//
// Nothing here touches the database or records an event. It answers with
// what it decided and the step records that, which is what lets every rule
// below be tested without a turn.
import type { Answer, DecisionModel, DecisionUsage, Question } from "../providers/decision/types.ts"
import type { Tool } from "../tools/index.ts"
import { answerOf, within } from "./decide.ts"

/** ROUTE-1's extra option: the brain can answer without a tool. */
export const NO_TOOL = "no_tool"
export const NO_TOOL_DESCRIPTION = "Answer from the conversation and knowledge, no action needed"

/** The question's name, so a step and its tests agree on it. */
export const ROUTING_QUESTION = "tool"

/**
 * A choice takes at most 255 options on both decision models, and one of
 * ours is always `no_tool`, so this many tools fit in one question.
 */
const TOOLS_PER_QUESTION = 254

/** ROUTE-2: the top tools until their combined probability reaches this. */
export const ENOUGH_MASS = 0.9

/** ROUTE-2: and never more than this many. */
export const MOST_TOOLS = 3

/** ROUTE-1: the last 6 messages, the current batch, and the active task. */
export interface RoutingState {
  messages: { role: string; text: string }[]
  batch: string[]
  /** M4 fills this in. Null until tasks exist. */
  activeTask: unknown
}

export interface RouteOptions {
  decisionModel: DecisionModel
  /** The agent tools this role allows. ROLE-3 has already been applied. */
  tools: Tool[]
  /** Built in tools for this role. They skip routing (BUILTIN-1). */
  builtins?: Tool[] | undefined
  state: RoutingState
  /** config.routingMinTools: routing runs above this many agent tools. */
  minTools: number
  /** config.decisionModel.routeThreshold (ROUTE-4). */
  threshold: number
  /** config.decisionTimeoutMs (ROUTE-5). */
  timeoutMs: number
  /**
   * DM-2: the step's other questions, which ride along in the same
   * request because the state is paid for once.
   *
   * LOOP-8 step 1: on the first step that is `wants_human` (HAND-1).
   * They are asked even when routing does not run, because the step
   * still has to ask them and one request is one request either way.
   */
  also?: Record<string, Question> | undefined
  /**
   * LIMIT-3: what one decision call cost.
   *
   * Injected because the answer depends on the config's pricing table,
   * which this file has no business reading. Without it, only a cost the
   * provider reported is counted, which is what every caller before
   * T7.3 wanted.
   */
  price?: ((usage: DecisionUsage) => number) | undefined
}

export interface RouteDecision {
  /** The agent tools routing chose, the winner first. */
  tools: Tool[]
  /** The built in tools, which were never in question (BUILTIN-1). */
  builtins: Tool[]
  /** What the brain should be offered: the built ins, then the chosen. */
  exposed: Tool[]
  /**
   * `not_routed`      too few tools to be worth asking
   * `top_pick`        a confident tool, so only the top few are shown
   * `no_tool`         a confident no_tool, so no agent tools are shown
   * `below_threshold` not confident, so everything is shown
   * `fallback`        no usable answer, so everything is shown (ROUTE-5)
   */
  reason: "not_routed" | "top_pick" | "no_tool" | "below_threshold" | "fallback"
  choice?: string | undefined
  confidence?: number | undefined
  probabilities?: Record<string, number> | undefined
  /** Why routing fell back, when it did. */
  error?: string | undefined
  /** The answers to `also`, when there were any to ask. */
  also?: Record<string, Answer> | undefined
  /** Decision requests made. 2 when DM-3 had to split the options. */
  requests: number
  costUsd: number
}

/** ROUTE-1: the choice question for a set of tools. */
export function routingQuestion(tools: Tool[]): Extract<Question, { type: "choice" }> {
  const options: Record<string, string | null> = {}
  // TOOL-3's text, which is what makes the choice answerable: the
  // description, then the call when and don't call when lines.
  for (const tool of tools) options[tool.name] = tool.brainDescription
  options[NO_TOOL] = NO_TOOL_DESCRIPTION

  return {
    type: "choice",
    instructions:
      "Which of these tools should answer the person's latest message? Choose no_tool if the conversation and the agent's knowledge are enough.",
    options,
  }
}

/** Groups of tools that each fit in one choice question (DM-3). */
function split(tools: Tool[]): Tool[][] {
  const groups: Tool[][] = []
  for (let at = 0; at < tools.length; at += TOOLS_PER_QUESTION) {
    groups.push(tools.slice(at, at + TOOLS_PER_QUESTION))
  }
  return groups
}

/**
 * One answered choice, as the parts routing needs from it.
 *
 * Exported because `openbox tune` records one of these per labeled example
 * and then measures every candidate threshold against it offline. That is
 * what makes tuning one request per example rather than one per example
 * per threshold.
 */
export interface Picked {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

function pickedFrom(answers: Record<string, Answer>, name: string): Picked {
  const answer = answerOf(answers, name, "choice")
  return {
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  }
}

/**
 * ROUTE-2's first line: the top tools, in order, until their combined
 * probability reaches 0.9, at most 3.
 *
 * The winner goes first whatever the spread says, because the decision
 * model's own `choice` is the answer and the spread is its working. A
 * `no_tool` among the top counts towards the mass, since the mass is a
 * statement about the distribution, but it is not a tool to expose.
 */
export function topTools(picked: Picked, tools: Tool[]): Tool[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const winner = byName.get(picked.choice)
  const chosen: Tool[] = winner ? [winner] : []
  let mass = picked.probabilities[picked.choice] ?? 0

  const rest = Object.entries(picked.probabilities)
    .filter(([name]) => name !== picked.choice)
    .sort((a, b) => b[1] - a[1])

  for (const [name, probability] of rest) {
    if (mass >= ENOUGH_MASS || chosen.length >= MOST_TOOLS) break
    mass += probability
    const tool = byName.get(name)
    // A name that is not a tool here is either no_tool or something the
    // role does not allow. Either way it is not exposed.
    if (tool !== undefined) chosen.push(tool)
  }

  return chosen
}

/**
 * ROUTE-1 to ROUTE-5, and whatever else this step has to ask (DM-2).
 *
 * The extra answers are collected on the way through and attached
 * here, rather than threaded through six return paths that are all
 * about routing and none about them.
 */
export async function route(options: RouteOptions): Promise<RouteDecision> {
  const extra: Record<string, Answer> = {}
  const decision = await decide(options, extra)
  return Object.keys(extra).length > 0 ? { ...decision, also: extra } : decision
}

async function decide(
  options: RouteOptions,
  extra: Record<string, Answer>,
): Promise<RouteDecision> {
  const { decisionModel, tools, state, minTools, threshold, timeoutMs } = options
  const price = options.price ?? ((usage: DecisionUsage): number => usage.costUsd ?? 0)
  const also = options.also ?? {}
  const alsoNames = Object.keys(also)
  const builtins = options.builtins ?? []
  const everything = (
    reason: RouteDecision["reason"],
    extra: Partial<RouteDecision> = {},
  ): RouteDecision => ({
    tools,
    builtins,
    exposed: [...builtins, ...tools],
    reason,
    requests: 0,
    costUsd: 0,
    ...extra,
  })

  // ROUTE-1: routing runs only above config.routingMinTools agent tools.
  // Built in tools do not count: they are exposed either way, so they
  // cannot make a short tool list worth narrowing.
  if (tools.length <= minTools) {
    // DM-2: the step's other questions still have to be asked, and a
    // small agent is exactly the case where this is the only request.
    if (alsoNames.length === 0) return everything("not_routed")
    try {
      const only = await within(decisionModel.ask(state, also), timeoutMs)
      Object.assign(extra, only.answers)
      return { ...everything("not_routed"), requests: 1, costUsd: price(only.usage) }
    } catch (error) {
      // The same trade as ROUTE-5: an optimisation and a hint, neither
      // worth spending the person's wait on a retry.
      return {
        ...everything("not_routed"),
        error: error instanceof Error ? error.message : String(error),
        requests: 1,
      }
    }
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const groups = split(tools)
  let requests = 0
  let costUsd = 0

  try {
    // DM-2: the groups are independent, so they go in one request. Only
    // the runoff has to wait for their answers.
    const questions: Record<string, Question> = { ...also }
    const groupNames = groups.map((_, index) =>
      groups.length === 1 ? ROUTING_QUESTION : `tool_group_${index}`,
    )
    groups.forEach((group, index) => {
      questions[groupNames[index]!] = routingQuestion(group)
    })

    const first = await within(decisionModel.ask(state, questions), timeoutMs)
    requests++
    costUsd += price(first.usage)
    for (const name of alsoNames) {
      const answer = first.answers[name]
      if (answer !== undefined) extra[name] = answer
    }

    let picked: Picked
    if (groups.length === 1) {
      picked = pickedFrom(first.answers, ROUTING_QUESTION)
    } else {
      // DM-3: a second choice over the group winners.
      const winners = groupNames
        .map((name) => pickedFrom(first.answers, name))
        .filter((group) => group.choice !== NO_TOOL)

      if (winners.length === 0) {
        // Every group said none of mine, which is a no_tool answer with
        // nothing left to run off. Its confidence is the least sure group,
        // because all of them have to be right for this to be right.
        const confidences = groupNames.map((name) => pickedFrom(first.answers, name).confidence)
        picked = {
          choice: NO_TOOL,
          confidence: Math.min(...confidences),
          probabilities: { [NO_TOOL]: 1 },
        }
      } else if (winners.length === 1) {
        // One candidate, already compared against no_tool inside its own
        // group, so there is nothing a runoff would add.
        picked = winners[0]!
      } else {
        const runoff = await within(
          decisionModel.ask(state, {
            [ROUTING_QUESTION]: routingQuestion(
              winners
                .map((group) => byName.get(group.choice))
                .filter((t): t is Tool => t !== undefined),
            ),
          }),
          timeoutMs,
        )
        requests++
        costUsd += price(runoff.usage)
        picked = pickedFrom(runoff.answers, ROUTING_QUESTION)
      }
    }

    // ROUTE-2, in the Spec's own order.
    if (picked.confidence < threshold) {
      return {
        ...everything("below_threshold"),
        choice: picked.choice,
        confidence: picked.confidence,
        probabilities: picked.probabilities,
        requests,
        costUsd,
      }
    }

    if (picked.choice === NO_TOOL) {
      return {
        tools: [],
        builtins,
        exposed: [...builtins],
        reason: "no_tool",
        choice: NO_TOOL,
        confidence: picked.confidence,
        probabilities: picked.probabilities,
        requests,
        costUsd,
      }
    }

    const chosen = topTools(picked, tools)
    return {
      tools: chosen,
      builtins,
      exposed: [...builtins, ...chosen],
      reason: "top_pick",
      choice: picked.choice,
      confidence: picked.confidence,
      probabilities: picked.probabilities,
      requests,
      costUsd,
    }
  } catch (error) {
    // ROUTE-5: a failure, a timeout, or an answer that cannot be read. The
    // step proceeds as if confidence were below the threshold. Nothing is
    // retried: a step has a few seconds in total, and spending the
    // person's wait on an optimisation is the wrong trade.
    return {
      ...everything("fallback"),
      error: error instanceof Error ? error.message : String(error),
      requests,
      costUsd,
    }
  }
}
