// LOOP-8: the step loop.
//
// Steps 1 and 2 are routing (ROUTE-1 to ROUTE-5), step 9 is the gate
// (GATE-1 to GATE-5). Confirmation, handover and the built in tools are
// not here yet. The order of the steps is the order the Spec gives, so the
// later milestones slot in rather than rearrange.
//
// Every call a step makes is written down whatever becomes of it: a row in
// `ob_tool_runs` with the arguments the brain proposed, and a row in
// `ob_decisions` for each decision model call. Being blocked by the gate
// is as much a thing that happened as running.
import type { OpenboxConfig } from "../config/index.ts"
import type { Brain, BrainMessage } from "../providers/brains/types.ts"
import { BrainError } from "../providers/brains/types.ts"
import type { Store, PersonRow } from "../store/index.ts"
import type { Tool, ToolRegistry, ToolContext } from "../tools/index.ts"
import type { Clock } from "../testing/clock.ts"
import { buildMessages, buildRuntimeBlock, buildSystem } from "./context.ts"
import type { MessageRow } from "../store/index.ts"
import { noEvents, type EventWriter } from "./events.ts"
import { route, ROUTING_QUESTION, type RoutingState } from "./routing.ts"
import { WANTS_HUMAN, wantsHumanQuestion } from "./handover.ts"
import { gate, type GateConversation } from "./gate.ts"
import { toolContext } from "./tool-context.ts"
import type { FactRow, PendingActionRow, TaskRow } from "../store/index.ts"
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
  /**
   * CONF-2: what the brain is told happened before this turn started.
   *
   * A confirmation is resolved by the core before the brain is asked
   * anything, so the brain has to be told the outcome rather than discover
   * it. These go in after the person's messages, as notices, because that
   * is when they happened.
   */
  notices?: string[] | undefined
  /**
   * ROUTE-1 and GATE-1: the task the brain is working on, as both the
   * routing question and the gate reason over it. Null until one is open.
   */
  activeTask?: unknown
  /** LOOP-7 and TOOL-4: what is remembered about this person. */
  facts?: FactRow[] | undefined
  /** LOOP-7: this person's open tasks, for the runtime block. */
  tasks?: TaskRow[] | undefined
  /** LOOP-7: what they have been asked to confirm and has not expired. */
  pendingActions?: PendingActionRow[] | undefined
  /**
   * CONF-1: makes a pending action when an irreversible call passes the
   * gate. Absent for an agent with no irreversible tools, in which case
   * nothing here can ever ask for one.
   */
  confirm?:
    | {
        create(request: {
          person: PersonRow
          turnId: string
          tool: Tool
          args: Record<string, unknown>
        }): Promise<PendingActionRow>
      }
    | undefined
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
   * BRAIN-3: every tool call a brain asked for beyond the first, in order.
   * Named rather than counted, because which one was dropped is the part
   * worth reading.
   */
  droppedCalls: string[]
  /**
   * GATE-3: a trigger this turn noticed, in the order it noticed them.
   * Two Blocks in a row, or two routing picks below the threshold in a
   * row, for the same person. Opening the handover is T6.2, so for now the
   * turn reports the trigger and nothing acts on it.
   */
  handoverDue: HandoverTrigger[]
  /**
   * `failed` is not produced here. `createAgent` uses it for a turn that
   * ended in a way the core did not plan for, so a caller of
   * `receiveAndWait` gets a result rather than a rejection.
   *
   * Nor are `blocked` and `handover`. Both are LOOP-5 checks, which run
   * before anything in this file, so neither turn reaches it (ROLE-4,
   * HAND-5).
   */
  outcome: "replied" | "no_reply" | "step_cap" | "brains_failed" | "failed" | "blocked" | "handover"
  /** Set only when the outcome is `failed`. */
  error?: string | undefined
}

/**
 * HAND-1's repeat triggers, as the turn notices them.
 *
 * GATE-3 has two: two Blocks in a row, and two routing picks below the
 * threshold in a row. LOOP-10 has the third: the same tool failing
 * twice in a row for the same person, in this turn or across turns.
 * And the decision model's own answer on step 1 is the fourth.
 *
 * The names match `HandoverReason`, so nothing has to translate, and
 * `escalate` is not here: that one is a tool, which opens it itself.
 */
export type HandoverTrigger =
  | "gate_block_repeat"
  | "low_confidence_repeat"
  | "tool_failed_repeat"
  | "wants_human"

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

  // CONF-2 and CONF-8: what the core already did, in the order it
  // happened, which is after the person spoke and before the brain is
  // asked anything.
  for (const text of input.notices ?? []) messages.push({ role: "notice", text })

  const system = buildSystem(
    prompt,
    buildRuntimeBlock({
      config,
      person,
      now: clock.now(),
      ...(input.facts !== undefined ? { facts: input.facts } : {}),
      ...(input.tasks !== undefined ? { tasks: input.tasks } : {}),
      ...(input.pendingActions !== undefined ? { pendingActions: input.pendingActions } : {}),
    }),
  )

  // ROLE-3 removes what this role may not use. Everything left is offered,
  // whatever its risk: a write or irreversible call is held back by the
  // gate at step 9, not by never being mentioned. A tool the brain cannot
  // see is a tool the agent cannot use, and the gate is the thing that
  // decides whether a call runs.
  const allowed = tools.forRole(person.role)

  // BUILTIN-1: the core's own tools are exposed on every step whatever
  // routing decides, and they do not count toward routingMinTools. An
  // agent with four tools and the task tools is still a small agent.
  const builtins = tools.builtinsForRole(person.role)

  /**
   * LOOP-10: whether this tool's last two runs for this person both
   * failed. Called straight after recording a failure, so the newest
   * row is the one that just happened.
   */
  async function failedTwice(name: string): Promise<boolean> {
    const last = await store.toolRuns.list(
      { person_id: person.id, tool: name },
      { orderBy: "seq", ascending: false, limit: 2 },
    )
    return last.length === 2 && last.every((row) => row.status === "error")
  }

  /** The last 6 messages, which both routing and the gate reason over. */
  const recent = (): { role: string; text: string }[] =>
    messages
      .filter((message) => message.role === "person" || message.role === "agent")
      .slice(-6)
      .map((message) => ({
        role: message.role,
        text: "text" in message ? message.text : "",
      }))

  // ROUTE-1: the state routing reasons over. The last 6 messages, the
  // batch, and the active task, which arrives with tasks in M4.
  const routingState = (): RoutingState => ({
    messages: recent(),
    batch,
    activeTask: input.activeTask ?? null,
  })

  // GATE-1: the same window, without the batch, which is already the last
  // of those messages.
  const gateConversation = (): GateConversation => ({
    messages: recent(),
    activeTask: input.activeTask ?? null,
  })

  // TOOL-4: by key, which is how a handler wants them.
  const knownFacts: Record<string, string> = {}
  for (const fact of input.facts ?? []) knownFacts[fact.key] = fact.value

  const brainsUsed: string[] = []
  const toolsRun: { name: string; ok: boolean }[] = []
  const routed: TurnResult["routed"] = []
  const handoverDue: HandoverTrigger[] = []
  /** BRAIN-3: tool calls a brain asked for beyond the first. */
  const droppedCalls: string[] = []
  let costUsd = 0
  let steps = 0

  while (steps < config.maxSteps) {
    steps++

    // Steps 1 and 2: routing decides which tools this step offers. It runs
    // on every step (ROUTE-3), so after one tool's result the next step
    // can route somewhere else.
    const routedAt = clock.now().getTime()
    const routing = await route({
      decisionModel,
      tools: allowed,
      builtins,
      state: routingState(),
      minTools: config.routingMinTools,
      threshold: config.decisionModel.routeThreshold,
      timeoutMs: config.decisionTimeoutMs,
      // LOOP-8 step 1: on the first step the same request also asks
      // whether this person wants a human (HAND-1). DM-2 is why it
      // rides along rather than being asked on its own.
      ...(steps === 1 && person.role === "end_user"
        ? { also: { [WANTS_HUMAN]: wantsHumanQuestion() } }
        : {}),
    })
    const offered = routing.exposed
    costUsd += routing.costUsd
    routed.push({
      step: steps,
      reason: routing.reason,
      ...(routing.choice !== undefined ? { choice: routing.choice } : {}),
    })

    // HAND-1: at or above the threshold is a handover trigger. Recorded
    // either way, because a question that was asked and paid for is
    // worth reading later whichever way it went.
    const human = routing.also?.[WANTS_HUMAN]
    if (human !== undefined && human.type === "yesno") {
      const wants = human.p >= config.handover.wantsHumanThreshold
      await events.decision({
        kind: "wants_human",
        outcome: wants ? "handover" : "no",
        answers: { [WANTS_HUMAN]: human },
        model: decisionModel.id,
        step: steps,
        durationMs: clock.now().getTime() - routedAt,
        costUsd: 0,
      })
      if (wants) handoverDue.push("wants_human")
    }

    if (routing.reason !== "not_routed") {
      await events.record("route_decided", {
        step: steps,
        reason: routing.reason,
        exposed: offered.map((tool) => tool.name),
        requests: routing.requests,
        ...(routing.choice !== undefined ? { choice: routing.choice } : {}),
        ...(routing.confidence !== undefined ? { confidence: routing.confidence } : {}),
      })

      // DATA-2: the decision itself, so a threshold can be tuned against
      // what the model actually said (LEARN-5), and so GATE-3 has
      // something to count.
      const recorded = await events.decision({
        kind: "route",
        outcome: routing.reason,
        answers:
          routing.choice === undefined
            ? {}
            : {
                [ROUTING_QUESTION]: {
                  type: "choice",
                  choice: routing.choice,
                  confidence: routing.confidence,
                  probabilities: routing.probabilities,
                },
              },
        model: decisionModel.id,
        step: steps,
        durationMs: clock.now().getTime() - routedAt,
        costUsd: routing.costUsd,
      })

      // LEARN-1: a pick the model was not sure about is worth a builder's
      // attention, because it is usually a conditions problem rather than
      // a model problem. A fallback is not flagged here: there was no pick
      // to be unsure about, and `fallback_used` already says the model was
      // unreachable.
      if (routing.reason === "below_threshold") {
        await events.flag("low_confidence", {
          step: steps,
          threshold: config.decisionModel.routeThreshold,
          ...(routing.choice !== undefined ? { choice: routing.choice } : {}),
          ...(routing.confidence !== undefined ? { confidence: routing.confidence } : {}),
        })
        // GATE-3: twice in a row for the same person.
        if (recorded.repeated) handoverDue.push("low_confidence_repeat")
      }
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
    const brainsFailed: { brain: string; error: string }[] = []

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
            what: "brain",
            brain: brain.id,
            failed: [...brainsFailed],
            step: steps,
          })
        }
        break
      } catch (error) {
        // BRAIN-5: a timeout, an error, or output that failed the shape
        // twice. Any throw moves to the next brain, including one that is
        // not a `BrainError`.
        //
        // That last part is deliberate and was not always so. An adapter
        // that threw a plain `TypeError` used to end the turn, on the
        // reasoning that a bug should not be masked by a fallback. But the
        // person loses their answer either way, and the bug is not hidden:
        // the brain, the error and the fallback are all in the trace. A
        // slower answer beats no answer.
        lastError = error
        brainsFailed.push({
          brain: brain.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (!answered || output === undefined) {
      // BRAIN-5 has run out of brains. LOOP-12's holding message and the
      // operator alert are M7; here the turn ends and the trace says which
      // brains were tried and what each of them said.
      await events.record("fallback_used", {
        what: "brain",
        brain: null,
        failed: [...brainsFailed],
        step: steps,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      })
      return {
        steps,
        costUsd,
        brainsUsed,
        toolsRun,
        routed,
        handoverDue,
        droppedCalls,
        outcome: "brains_failed",
      }
    }

    costUsd += output.usage.costUsd ?? 0

    // BRAIN-3: more than one tool call means the first is taken and the
    // rest are recorded as dropped.
    //
    // Not run in parallel, and not queued for later. A brain that asks for
    // two things at once has not seen the result of the first, so the
    // second was decided without it: LOOP-8 step 10 exists to give it that
    // result and let it decide again. Running both would act on a guess.
    const dropped = (output.toolCalls ?? []).slice(1).map((extra) => extra.name)
    if (dropped.length > 0) droppedCalls.push(...dropped)

    // Step 4: a reply ends the turn.
    const call = output.toolCalls?.[0]
    if (call === undefined) {
      const reply = output.text?.trim()
      return reply === undefined || reply === ""
        ? {
            steps,
            costUsd,
            brainsUsed,
            toolsRun,
            routed,
            handoverDue,
            droppedCalls,
            outcome: "no_reply",
          }
        : {
            reply,
            steps,
            costUsd,
            brainsUsed,
            toolsRun,
            routed,
            handoverDue,
            droppedCalls,
            outcome: "replied",
          }
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
        ...(dropped.length > 0 ? { dropped } : {}),
      })
      // The arguments are recorded as the brain sent them, unvalidated,
      // which is the only form they exist in. A review of a tool nobody
      // can call correctly needs to see what was actually tried.
      await events.toolRun({
        tool: tool.name,
        risk: tool.risk,
        status: "error",
        args: call.input,
        error,
        step: steps,
        durationMs: 0,
      })

      messages.push({ role: "tool_result", id: call.id, name: call.name, result: null, error })
      continue
    }

    // Step 9: a write or an irreversible call goes through the gate. A
    // read tool comes straight back as `not_gated` (GATE-5), without a
    // request being made, so reading costs nothing and cannot be stopped
    // by a decision model being down.
    const gatedAt = clock.now().getTime()
    const decision = await gate({
      decisionModel,
      tool,
      args: parsed.data,
      conversation: gateConversation(),
      bands: config.decisionModel.gateBands,
      timeoutMs: config.decisionTimeoutMs,
    })
    const gateMs = clock.now().getTime() - gatedAt
    costUsd += decision.costUsd

    if (decision.reason !== "not_gated") {
      const recorded = await events.decision({
        kind: "gate",
        outcome: decision.reason,
        answers: decision.answers ?? {},
        model: decisionModel.id,
        step: steps,
        durationMs: gateMs,
        costUsd: decision.costUsd,
      })

      const props = {
        tool: tool.name,
        risk: tool.risk,
        step: steps,
        reason: decision.reason,
        ...(decision.p !== undefined ? { p: decision.p } : {}),
        ...(decision.band !== undefined ? { band: decision.band } : {}),
        ...(decision.error !== undefined ? { error: decision.error } : {}),
      }

      // EVT-2's three names for the three things the gate can decide.
      // `guard_block` rather than `gate_block`, to match the effect kind
      // evals-agent already records.
      if (decision.outcome === "run") await events.record("gate_passed", props)
      else if (decision.outcome === "confirm") await events.record("gate_confirm", props)
      else await events.record("guard_block", props)

      if (decision.outcome === "block") {
        await events.flag("gate_block", props)
        // GATE-3: two Blocks in a row for the same person.
        if (recorded.repeated) handoverDue.push("gate_block_repeat")
      }
    }

    if (decision.outcome !== "run") {
      // CONF-1: an irreversible call that passed the gate becomes a
      // pending action, and the core asks the person itself. Everything
      // else that is not run is simply reported back to the brain.
      let pending: PendingActionRow | undefined
      if (decision.reason === "needs_confirm" && input.confirm !== undefined) {
        pending = await input.confirm.create({
          person,
          turnId,
          tool,
          args: parsed.data as Record<string, unknown>,
        })
      }

      // GATE-2: not run. The brain is told, and told what to do instead,
      // because a tool result that only says no leaves it guessing.
      const told =
        pending !== undefined
          ? [
              `${tool.name} has not run. It cannot be undone, so the person has to confirm it first.`,
              `They have been asked to confirm: "${pending.summary}"`,
              "Tell them you have asked, and do not say the action is done. It runs only when they confirm.",
            ].join("\n\n")
          : (decision.message ?? `${tool.name} did not run.`)

      await events.toolRun({
        tool: tool.name,
        risk: tool.risk,
        status:
          decision.outcome === "block"
            ? "blocked"
            : pending !== undefined
              ? "pending"
              : "needs_confirmation",
        args: parsed.data,
        error:
          decision.error !== undefined
            ? `the gate could not be answered: ${decision.error}`
            : `the gate said ${decision.reason}: p ${String(decision.p)}, bands pass ${String(
                decision.band?.pass,
              )} confirm ${String(decision.band?.confirm)}`,
        step: steps,
        durationMs: gateMs,
      })
      messages.push({
        role: "tool_result",
        id: call.id,
        name: tool.name,
        result: null,
        error: told,
      })
      continue
    }

    // Step 8: a read tool runs straight away. So does a write that passed.
    // TOOL-4: the facts as the turn started, so every step of one turn
    // sees the same person.
    const ctx: ToolContext = toolContext({
      store,
      clock,
      person,
      config,
      facts: knownFacts,
      turnId,
    })

    const ranAt = clock.now().getTime()
    try {
      const result = await tool.handler(parsed.data, ctx)
      toolsRun.push({ name: tool.name, ok: true })
      const durationMs = clock.now().getTime() - ranAt
      await events.record("tool_ran", {
        tool: tool.name,
        risk: tool.risk,
        step: steps,
        ok: true,
        ran: true,
        durationMs,
        // BRAIN-3: what the brain asked for alongside this and did not get.
        ...(dropped.length > 0 ? { dropped } : {}),
      })
      await events.toolRun({
        tool: tool.name,
        risk: tool.risk,
        status: "ok",
        args: parsed.data,
        result,
        step: steps,
        durationMs,
      })
      messages.push({ role: "tool_result", id: call.id, name: tool.name, result })
    } catch (error) {
      // LOOP-10: a thrown error goes back to the brain as an error result.
      const message = error instanceof Error ? error.message : String(error)
      toolsRun.push({ name: tool.name, ok: false })
      const durationMs = clock.now().getTime() - ranAt
      await events.record("tool_ran", {
        tool: tool.name,
        risk: tool.risk,
        step: steps,
        ok: false,
        ran: true,
        durationMs,
        error: message,
        ...(dropped.length > 0 ? { dropped } : {}),
      })
      await events.toolRun({
        tool: tool.name,
        risk: tool.risk,
        status: "error",
        args: parsed.data,
        error: message,
        step: steps,
        durationMs,
      })

      // LOOP-10: the same tool failing twice in a row for this person,
      // in this turn or across turns, is a handover trigger. Read from
      // the rows rather than kept in memory, because "across turns"
      // means a different process may have seen the first one.
      //
      // The run just recorded is the first row back, so two errors at
      // the top is twice in a row. Anything else in between, including a
      // success, breaks the run.
      if (await failedTwice(tool.name)) handoverDue.push("tool_failed_repeat")
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
  return {
    steps,
    costUsd,
    brainsUsed,
    toolsRun,
    routed,
    handoverDue,
    droppedCalls,
    outcome: "step_cap",
  }
}
