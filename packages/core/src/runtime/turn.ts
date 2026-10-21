// LOOP-8: the step loop.
//
// Steps 1 and 2 are routing (ROUTE-1 to ROUTE-5). The gate, confirmation,
// handover and the built in tools are not here yet, so only read tools are
// exposed and a write or irreversible tool is simply not offered. The
// order of the steps is the order the Spec gives, so the later milestones
// slot in rather than rearrange.
import type { OpenboxConfig } from "../config/index.ts"
import type { Brain, BrainMessage } from "../providers/brains/types.ts"
import { BrainError } from "../providers/brains/types.ts"
import type { Store, PersonRow } from "../store/index.ts"
import type { Tool, ToolRegistry, ToolContext } from "../tools/index.ts"
import type { Clock } from "../testing/clock.ts"
import { buildMessages, buildRuntimeBlock, buildSystem } from "./context.ts"
import type { MessageRow } from "../store/index.ts"
import { noEvents, type EventWriter } from "./events.ts"
import { route, type RoutingState } from "./routing.ts"
import type { DecisionModel } from "../providers/decision/types.ts"

export interface TurnInput {
  config: OpenboxConfig
  /**
   * The recent conversation, oldest first, not including the batch being
   * answered. The caller reads it before storing the new message, so the
   * brain is not shown it twice (LOOP-7).
   */
  history: MessageRow[]
  store: Store
  brains: Brain[]
  /** DM-1: what routing asks (ROUTE-1). */
  decisionModel: DecisionModel
  models: string[]
  tools: ToolRegistry
  clock: Clock
  person: PersonRow
  /** The messages this turn is answering, in arrival order (LOOP-3). */
  batch: string[]
  prompt: string
  turnId: string
  /** EVT-1: where each step records what it did. Defaults to recording nothing. */
  events?: EventWriter | undefined
}

export interface TurnResult {
  /** The turn row this was, so a caller can find what it sent (API-2). */
  turnId?: string | undefined
  /** What the agent decided to say, if anything. */
  reply?: string | undefined
  steps: number
  costUsd: number
  /** Which brain answered each step, in order (BRAIN-5, DEP-3). */
  brainsUsed: string[]
  toolsRun: { name: string; ok: boolean }[]
  /** One entry per step: what routing decided, for the trace and tests. */
  routed: { step: number; reason: string; choice?: string | undefined }[]
  /**
   * `failed` is not produced here. `createAgent` uses it for a turn that
   * ended in a way the core did not plan for, so a caller of
   * `receiveAndWait` gets a result rather than a rejection.
   */
  outcome: "replied" | "no_reply" | "step_cap" | "brains_failed" | "failed"
  /** Set only when the outcome is `failed`. */
  error?: string | undefined
}

/** LOOP-8 step 5: the brain called something it was not offered. */
function unknownToolResult(name: string, offered: Tool[]): string {
  const names = offered.map((tool) => tool.name)
  const list = names.length === 0 ? "none" : names.join(", ")
  return `There is no tool called ${name}. The tools you can call are: ${list}.`
}

/**
 * Runs one turn. Returns when the brain replies, runs out of steps, or
 * every brain fails.
 */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const { config, history, store, brains, models, tools, clock, person, batch, prompt, turnId } =
    input
  const decisionModel = input.decisionModel
  const events = input.events ?? noEvents()

  // LOOP-7, then LOOP-8 step 10: this turn's own calls and results are
  // appended as the loop goes, and become the input to the next step.
  const messages: BrainMessage[] = buildMessages(history, batch)

  const system = buildSystem(prompt, buildRuntimeBlock({ config, person, now: clock.now() }))

  // ROLE-3 removes what this role may not use. v0 offers only read tools,
  // because write and irreversible calls must pass the gate, which is M3.
  const allowed = tools.forRole(person.role).filter((tool) => tool.risk === "read")

  // ROUTE-1: the state routing reasons over. The last 6 messages, the
  // batch, and the active task, which arrives with tasks in M4.
  const routingState = (): RoutingState => ({
    messages: messages
      .filter((message) => message.role === "person" || message.role === "agent")
      .slice(-6)
      .map((message) => ({
        role: message.role,
        text: "text" in message ? message.text : "",
      })),
    batch,
    activeTask: null,
  })

  const brainsUsed: string[] = []
  const toolsRun: { name: string; ok: boolean }[] = []
  const routed: TurnResult["routed"] = []
  let costUsd = 0
  let steps = 0

  while (steps < config.maxSteps) {
    steps++

    // Steps 1 and 2: routing decides which tools this step offers. It runs
    // on every step (ROUTE-3), so after one tool's result the next step
    // can route somewhere else.
    const routing = await route({
      decisionModel,
      tools: allowed,
      state: routingState(),
      minTools: config.routingMinTools,
      threshold: config.decisionModel.routeThreshold,
      timeoutMs: config.decisionTimeoutMs,
    })
    const offered = routing.exposed
    costUsd += routing.costUsd
    routed.push({
      step: steps,
      reason: routing.reason,
      ...(routing.choice !== undefined ? { choice: routing.choice } : {}),
    })

    if (routing.reason !== "not_routed") {
      await events.record("route_decided", {
        step: steps,
        reason: routing.reason,
        exposed: offered.map((tool) => tool.name),
        requests: routing.requests,
        ...(routing.choice !== undefined ? { choice: routing.choice } : {}),
        ...(routing.confidence !== undefined ? { confidence: routing.confidence } : {}),
      })
    }

    if (routing.reason === "fallback") {
      // ROUTE-5. The same event name as a brain fallback, so `what` is
      // what tells the two apart in the trace.
      await events.record("fallback_used", {
        what: "decision_model",
        step: steps,
        ...(routing.error !== undefined ? { error: routing.error } : {}),
      })
    }

    // Step 3: the brain, with the fallback chain (BRAIN-5 proper is M5).
    let answered = false
    let output: Awaited<ReturnType<Brain["complete"]>> | undefined
    let lastError: unknown
    const brainsFailed: string[] = []

    for (const [index, brain] of brains.entries()) {
      try {
        output = await brain.complete({
          model: models[index] ?? models[0] ?? "",
          system,
          messages,
          tools: offered.map((tool) => ({
            name: tool.name,
            description: tool.brainDescription,
            inputSchema: tool.inputSchema,
          })),
        })
        brainsUsed.push(brain.id)
        answered = true
        if (index > 0) {
          await events.record("fallback_used", {
            brain: brain.id,
            failed: [...brainsFailed],
            step: steps,
          })
        }
        break
      } catch (error) {
        lastError = error
        brainsFailed.push(brain.id)
        if (!(error instanceof BrainError)) throw error
      }
    }

    if (!answered || output === undefined) {
      // LOOP-12 proper, with its holding message, is T2.x. Here the turn
      // simply ends and says so, rather than pretending it replied.
      void lastError
      return { steps, costUsd, brainsUsed, toolsRun, routed, outcome: "brains_failed" }
    }

    costUsd += output.usage.costUsd ?? 0

    // Step 4: a reply ends the turn.
    const call = output.toolCalls?.[0]
    if (call === undefined) {
      const reply = output.text?.trim()
      return reply === undefined || reply === ""
        ? { steps, costUsd, brainsUsed, toolsRun, routed, outcome: "no_reply" }
        : { reply, steps, costUsd, brainsUsed, toolsRun, routed, outcome: "replied" }
    }

    messages.push({ role: "tool_call", id: call.id, name: call.name, input: call.input })

    // Step 5: a name that was not offered is rejected, never executed.
    const tool = offered.find((candidate) => candidate.name === call.name)
    if (tool === undefined) {
      await events.record("unknown_tool", {
        tool: call.name,
        offered: offered.map((candidate) => candidate.name),
        step: steps,
      })
      messages.push({
        role: "tool_result",
        id: call.id,
        name: call.name,
        result: null,
        error: unknownToolResult(call.name, offered),
      })
      continue
    }

    // Step 6: arguments are checked before the handler sees them.
    const parsed = tool.safeParse(call.input)
    if (!parsed.success) {
      const error = `Those arguments are not valid for ${call.name}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`

      // EVT-2 has no name of its own for this. `ran: false` says the
      // handler never saw the call, so the trace cannot be misread as a
      // tool that failed while running.
      await events.record("tool_ran", {
        tool: tool.name,
        risk: tool.risk,
        step: steps,
        ok: false,
        ran: false,
        error,
      })

      messages.push({ role: "tool_result", id: call.id, name: call.name, result: null, error })
      continue
    }

    // Step 8: a read tool runs straight away.
    const ctx: ToolContext = {
      clock,
      person: {
        id: person.id,
        role: person.role,
        channel: person.channel,
        channelUserId: person.channel_user_id,
        displayName: person.display_name,
        language: person.language,
      },
      db: store,
      log: () => {},
    }

    const ranAt = clock.now().getTime()
    try {
      const result = await tool.handler(parsed.data, ctx)
      toolsRun.push({ name: tool.name, ok: true })
      await events.record("tool_ran", {
        tool: tool.name,
        risk: tool.risk,
        step: steps,
        ok: true,
        ran: true,
        durationMs: clock.now().getTime() - ranAt,
      })
      messages.push({ role: "tool_result", id: call.id, name: tool.name, result })
    } catch (error) {
      // LOOP-10: a thrown error goes back to the brain as an error result.
      const message = error instanceof Error ? error.message : String(error)
      toolsRun.push({ name: tool.name, ok: false })
      await events.record("tool_ran", {
        tool: tool.name,
        risk: tool.risk,
        step: steps,
        ok: false,
        ran: true,
        durationMs: clock.now().getTime() - ranAt,
        error: message,
      })
      messages.push({
        role: "tool_result",
        id: call.id,
        name: tool.name,
        result: null,
        error: message,
      })
    }
  }

  // LOOP-9's fixed reply, flag and operator alert are M7. v0 reports it.
  void turnId
  return { steps, costUsd, brainsUsed, toolsRun, routed, outcome: "step_cap" }
}
