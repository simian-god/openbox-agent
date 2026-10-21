// C8: is routing worth it?
//
// The claim routing has to earn is in three parts, and this script measures
// all three on one labeled set:
//
//   1. No call to a tool that does not exist, ever.
//   2. Routed turns have lower median latency and cost than the same turns
//      without routing.
//   3. With low confidence picks falling back to the brain, tool accuracy
//      is at least as good as the brain alone.
//
// The method is an A/B on the one thing routing changes. Each labeled
// example is answered twice: once with the tools routing chose, and once
// with every tool the role allows. Interleaved, so a slow minute on the
// provider hits both arms rather than whichever ran second.
//
// The routed arm is charged for everything it spends, the decision request
// included. That is the whole honesty of the measurement: routing buys a
// shorter tool list on the brain call and pays a decision request for it,
// and bar 2 is the question of whether that trade comes out ahead.
//
// Only one step is measured, not a whole turn. Routing changes exactly one
// thing, the tool list the brain is shown, and the rest of a turn costs the
// same either way. Adding the database and the outbox to both arms would
// move both medians by the same amount and tell you less, not more.
//
// Usage: bun run c8 --dir <agent> [--repeats 1] [--limit 0] [--tolerance]
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { route } from "../packages/core/src/runtime/routing.ts"
import { buildSystem, buildRuntimeBlock } from "../packages/core/src/runtime/context.ts"
import {
  examplesFromTools,
  mergeExamples,
  parseRoutingJsonl,
  isPositive,
  ROUTING_EXAMPLES_FILE,
  type LabeledExample,
} from "../packages/core/src/tune/index.ts"
import { loadProject, ProjectError } from "../packages/core/src/cli/project.ts"
import {
  providersFromConfig,
  modelsFromConfig,
  ProviderError,
} from "../packages/core/src/providers/index.ts"
import { fixedClock } from "../packages/core/src/testing/clock.ts"
import type { Brain, BrainMessage } from "../packages/core/src/providers/brains/types.ts"
import type { DecisionModel } from "../packages/core/src/providers/decision/types.ts"
import type { OpenboxConfig } from "../packages/core/src/config/index.ts"
import type { Tool } from "../packages/core/src/tools/index.ts"
import type { PersonRow } from "../packages/core/src/store/index.ts"

/** Which arm a measurement belongs to. */
export type Arm = "routed" | "all_tools"

/** One answered example, in one arm. */
export interface Measurement {
  arm: Arm
  where: string
  /** The tool the brain called, `null` when it replied instead. */
  called: string | null
  /** The label, when the example has one. */
  correct?: string | undefined
  notTool?: string | undefined
  /** How many agent tools the brain was shown. */
  exposed: number
  /** Wall clock for everything this arm spent on the step. */
  latencyMs: number
  costUsd: number
  /** The brain's share of it. Zero when the provider reported none. */
  brainCostUsd: number
  /** A call naming something that was never offered (LOOP-8 step 5). */
  invented: boolean
  error?: string | undefined
}

export interface ArmSummary {
  arm: Arm
  answered: number
  /** Positives where the brain called the labeled tool. */
  correct: number
  accuracy: number
  /** Negatives where it called the tool the example warned against. */
  calledWarnedAgainst: number
  invented: number
  medianLatencyMs: number
  medianCostUsd: number
  totalCostUsd: number
  /** What the brain alone charged, which is what bar 2 turns on. */
  totalBrainCostUsd: number
  meanExposed: number
  errors: number
}

export interface Bar {
  id: string
  what: string
  pass: boolean
  detail: string
}

export interface C8Report {
  brain: string
  model: string
  decisionModel: string
  /** True when the brain is the scripted fake, so it cost nothing. */
  simulated: boolean
  /**
   * True when the brain told us what it charged.
   *
   * Bar 2 is a question about money, so without this it has no answer. A
   * fake brain is one way to get here. A real provider that returns no
   * cost in its usage object is another, and until the pricing table lands
   * (LIMIT-3, M7) there is nothing to fall back on.
   */
  costReported: boolean
  examples: number
  repeats: number
  routed: ArmSummary
  allTools: ArmSummary
  bars: Bar[]
  pass: boolean
}

export interface C8Options {
  brain: Brain
  model: string
  decisionModel: DecisionModel
  tools: Tool[]
  examples: LabeledExample[]
  prompt: string
  config: OpenboxConfig
  /** How many times to answer each example, for a steadier median. */
  repeats?: number | undefined
  onProgress?: ((done: number, total: number) => void) | undefined
}

/** A stand in person, so the runtime block is as long as a real one. */
const SOMEONE: PersonRow = {
  id: "00000000-0000-0000-0000-000000000000",
  agent_id: "measure",
  channel: "whatsapp",
  channel_user_id: "measure",
  role: "end_user",
  display_name: "Asha",
  language: null,
  blocked: false,
  opted_out: false,
  notice_shown_at: null,
  created_at: "2026-10-19T06:00:00Z",
  updated_at: "2026-10-19T06:00:00Z",
}

const CLOCK = fixedClock("2026-10-19T06:00:00Z")

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

/** LOOP-7's messages, built from a labeled example. */
function messagesOf(example: LabeledExample): BrainMessage[] {
  const history: BrainMessage[] = example.messages.map((message) =>
    message.role === "agent"
      ? { role: "agent", text: message.text }
      : { role: "person", text: message.text },
  )
  return [...history, ...example.batch.map((text): BrainMessage => ({ role: "person", text }))]
}

/** One arm of one example: expose these tools, ask the brain, time it. */
async function askBrain(
  options: C8Options,
  example: LabeledExample,
  exposed: Tool[],
  arm: Arm,
  spentMs: number,
  spentUsd: number,
): Promise<Measurement> {
  const system = buildSystem(
    options.prompt,
    buildRuntimeBlock({ config: options.config, person: SOMEONE, now: CLOCK.now() }),
  )

  const started = Date.now()
  try {
    const output = await options.brain.complete({
      model: options.model,
      system,
      messages: messagesOf(example),
      tools: exposed.map((tool) => ({
        name: tool.name,
        description: tool.brainDescription,
        inputSchema: tool.inputSchema,
      })),
    })
    const call = output.toolCalls?.[0]
    const offered = new Set(exposed.map((tool) => tool.name))

    return {
      arm,
      where: example.where,
      called: call?.name ?? null,
      ...(example.tool !== undefined ? { correct: example.tool } : {}),
      ...(example.notTool !== undefined ? { notTool: example.notTool } : {}),
      exposed: exposed.length,
      latencyMs: spentMs + (Date.now() - started),
      costUsd: spentUsd + (output.usage.costUsd ?? 0),
      brainCostUsd: output.usage.costUsd ?? 0,
      // LOOP-8 step 5 rejects these at runtime. Here they are counted,
      // because C8's first bar is that they never happen.
      invented: call !== undefined && !offered.has(call.name),
    }
  } catch (error) {
    return {
      arm,
      where: example.where,
      called: null,
      ...(example.tool !== undefined ? { correct: example.tool } : {}),
      ...(example.notTool !== undefined ? { notTool: example.notTool } : {}),
      exposed: exposed.length,
      latencyMs: spentMs + (Date.now() - started),
      costUsd: spentUsd,
      brainCostUsd: 0,
      invented: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function summarise(arm: Arm, measurements: Measurement[]): ArmSummary {
  const mine = measurements.filter((entry) => entry.arm === arm)
  const good = mine.filter((entry) => entry.error === undefined)
  const positives = good.filter((entry) => entry.correct !== undefined)
  const negatives = good.filter((entry) => entry.notTool !== undefined)
  // ROUTE-1: `no_tool` is labeled as a tool name, and answering without a
  // call is what getting it right looks like.
  const correct = positives.filter((entry) =>
    entry.correct === "no_tool" ? entry.called === null : entry.called === entry.correct,
  ).length

  return {
    arm,
    answered: good.length,
    correct,
    accuracy: positives.length === 0 ? 0 : correct / positives.length,
    calledWarnedAgainst: negatives.filter((entry) => entry.called === entry.notTool).length,
    invented: good.filter((entry) => entry.invented).length,
    medianLatencyMs: median(good.map((entry) => entry.latencyMs)),
    medianCostUsd: median(good.map((entry) => entry.costUsd)),
    totalCostUsd: good.reduce((sum, entry) => sum + entry.costUsd, 0),
    totalBrainCostUsd: good.reduce((sum, entry) => sum + entry.brainCostUsd, 0),
    meanExposed:
      good.length === 0 ? 0 : good.reduce((sum, entry) => sum + entry.exposed, 0) / good.length,
    errors: mine.length - good.length,
  }
}

function barsFor(routed: ArmSummary, allTools: ArmSummary, costReported: boolean): Bar[] {
  const cheaper = routed.medianCostUsd < allTools.medianCostUsd
  const faster = routed.medianLatencyMs < allTools.medianLatencyMs

  return [
    {
      id: "C8.1",
      what: "no call to a tool that does not exist, ever",
      pass: routed.invented === 0 && allTools.invented === 0,
      detail: `routed ${routed.invented}, all tools ${allTools.invented}`,
    },
    {
      id: "C8.2",
      what: "routed turns have lower median latency and cost",
      // Bar 2 is a question about money and time, and a brain that
      // reported no cost cannot answer the money half. It would fail
      // either way, since the routed arm pays a decision request and
      // saves nothing, but failing with two zeroes side by side reads
      // like a measurement. This says there was nothing to measure.
      pass: costReported && faster && cheaper,
      detail: costReported
        ? `latency ${routed.medianLatencyMs} ms vs ${allTools.medianLatencyMs} ms, cost ${routed.medianCostUsd.toFixed(6)} vs ${allTools.medianCostUsd.toFixed(6)}`
        : "not measured: the brain reported no cost, so there are no tokens to compare",
    },
    {
      id: "C8.3",
      what: "accuracy is at least as good as the brain alone",
      pass: routed.accuracy >= allTools.accuracy,
      detail: `routed ${(routed.accuracy * 100).toFixed(1)}%, all tools ${(allTools.accuracy * 100).toFixed(1)}%`,
    },
  ]
}

export async function measureC8(options: C8Options): Promise<C8Report> {
  const repeats = options.repeats ?? 1
  const measurements: Measurement[] = []
  const total = options.examples.length * repeats
  let done = 0

  for (let pass = 0; pass < repeats; pass++) {
    for (const example of options.examples) {
      const allowed = options.tools.filter((tool) => tool.roles.includes(example.role))

      // The routed arm pays for its own decision request, in time and in
      // money, before the brain is asked anything.
      const startedRouting = Date.now()
      const decision = await route({
        decisionModel: options.decisionModel,
        tools: allowed,
        state: { messages: example.messages.slice(-6), batch: example.batch, activeTask: null },
        minTools: options.config.routingMinTools,
        threshold: options.config.decisionModel.routeThreshold,
        timeoutMs: options.config.decisionTimeoutMs,
      })
      const routingMs = Date.now() - startedRouting

      // Interleaved on purpose: a slow minute on the provider should hit
      // both arms, not whichever one happened to run second.
      measurements.push(
        await askBrain(options, example, decision.exposed, "routed", routingMs, decision.costUsd),
      )
      measurements.push(await askBrain(options, example, allowed, "all_tools", 0, 0))

      done++
      options.onProgress?.(done, total)
    }
  }

  const simulated = options.brain.id === "scripted"
  const routed = summarise("routed", measurements)
  const allTools = summarise("all_tools", measurements)
  const costReported = routed.totalBrainCostUsd + allTools.totalBrainCostUsd > 0
  const bars = barsFor(routed, allTools, costReported)

  return {
    brain: options.brain.id,
    model: options.model,
    decisionModel: options.decisionModel.id,
    simulated,
    costReported,
    examples: options.examples.length,
    repeats,
    routed,
    allTools,
    bars,
    pass: bars.every((bar) => bar.pass),
  }
}

export function formatC8(report: C8Report, name: string): string {
  const lines: string[] = []
  const row = (label: string, routed: string, all: string) =>
    `  ${label.padEnd(22)}${routed.padStart(14)}${all.padStart(14)}`

  lines.push(`C8 - ${name}`)
  lines.push("")
  lines.push(`Brain            ${report.brain} (${report.model})`)
  lines.push(`Decision model   ${report.decisionModel}`)
  lines.push(
    `Examples         ${report.examples}${report.repeats > 1 ? ` x ${report.repeats} passes` : ""}, answered twice each`,
  )
  if (!report.costReported) {
    lines.push("")
    if (report.simulated) {
      lines.push("This brain is the scripted fake. It costs nothing and answers at once,")
      lines.push("so the routed arm pays a decision request and saves nothing. The")
      lines.push("mechanics below are real; the latency and the cost are not.")
    } else {
      lines.push("This brain reported no cost in its usage, so the money half of bar 2")
      lines.push("has nothing to compare. The pricing table that would fill the gap is")
      lines.push("LIMIT-3, in M7.")
    }
  }
  lines.push("")
  lines.push(`  ${"".padEnd(22)}${"routed".padStart(14)}${"all tools".padStart(14)}`)
  lines.push(
    row(
      "tools shown",
      report.routed.meanExposed.toFixed(1),
      report.allTools.meanExposed.toFixed(1),
    ),
  )
  lines.push(
    row(
      "tool accuracy",
      `${(report.routed.accuracy * 100).toFixed(1)}%`,
      `${(report.allTools.accuracy * 100).toFixed(1)}%`,
    ),
  )
  lines.push(
    row(
      "median latency",
      `${report.routed.medianLatencyMs} ms`,
      `${report.allTools.medianLatencyMs} ms`,
    ),
  )
  lines.push(
    row(
      "median cost",
      report.routed.medianCostUsd.toFixed(6),
      report.allTools.medianCostUsd.toFixed(6),
    ),
  )
  lines.push(
    row(
      "total cost",
      report.routed.totalCostUsd.toFixed(5),
      report.allTools.totalCostUsd.toFixed(5),
    ),
  )
  lines.push(
    row(
      "called a tool warned against",
      String(report.routed.calledWarnedAgainst),
      String(report.allTools.calledWarnedAgainst),
    ),
  )
  lines.push(
    row("invented a tool", String(report.routed.invented), String(report.allTools.invented)),
  )
  if (report.routed.errors > 0 || report.allTools.errors > 0) {
    lines.push(row("not answered", String(report.routed.errors), String(report.allTools.errors)))
  }
  lines.push("")
  for (const bar of report.bars) {
    lines.push(`${bar.pass ? "PASS" : "FAIL"}  ${bar.id}  ${bar.what}`)
    lines.push(`        ${bar.detail}`)
  }
  return lines.join("\n")
}

/** Everything the script needs out of an agent project. */
export async function loadForC8(
  dir: string,
  examplesFile?: string,
): Promise<{
  tools: Tool[]
  examples: LabeledExample[]
  prompt: string
  config: OpenboxConfig
}> {
  const project = await loadProject({ dir })
  const path = examplesFile ?? join(project.dir, ROUTING_EXAMPLES_FILE)
  const names = project.tools.map((tool) => tool.name)

  let fromFile: LabeledExample[] = []
  if (existsSync(path)) {
    const parsed = parseRoutingJsonl(readFileSync(path, "utf8"), path, names)
    if (parsed.problems.length > 0) {
      throw new Error(`${path} has problems:\n  - ${parsed.problems.join("\n  - ")}`)
    }
    fromFile = parsed.examples
  }

  return {
    tools: project.tools,
    // Only the labeled positives and the warnings, both of which say
    // something about what the brain should do.
    examples: mergeExamples(examplesFromTools(project.tools), fromFile),
    prompt: project.prompt,
    config: project.config,
  }
}

async function main(argv: string[]): Promise<number> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith("--")) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next)
      i++
    } else {
      flags.set(arg.slice(2), "true")
    }
  }

  const dir = flags.get("dir")
  if (dir === undefined || flags.has("help")) {
    console.log(`C8 - is routing worth it?

Answers one labeled set twice, once with the tools routing chose and once
with every tool, and reports the three things C8 asks for.

Usage:
  bun run c8 --dir <agent project> [options]

Options:
  --dir <dir>        the agent project. Required
  --examples <file>  defaults to examples/routing.jsonl
  --repeats <n>      answer each example this many times. Defaults to 1
  --limit <n>        use only the first n examples
  --go               actually make the calls. Without it, this only says
                     how many it would make and what they would be
`)
    return dir === undefined ? 1 : 0
  }

  let loaded: Awaited<ReturnType<typeof loadForC8>>
  try {
    loaded = await loadForC8(dir, flags.get("examples"))
  } catch (error) {
    if (error instanceof ProjectError || error instanceof Error) {
      console.error(error.message)
      return 1
    }
    throw error
  }

  if (loaded.tools.length <= loaded.config.routingMinTools) {
    console.error(
      [
        `This agent has ${loaded.tools.length} tool${loaded.tools.length === 1 ? "" : "s"} and routingMinTools is ${loaded.config.routingMinTools},`,
        "so routing never runs and there are no two arms to compare.",
        "C8 needs an agent routing actually applies to.",
      ].join("\n"),
    )
    return 1
  }

  let brains: Brain[]
  let decisionModel: DecisionModel
  try {
    const built = providersFromConfig(loaded.config, {}, process.env)
    brains = built.brains
    decisionModel = built.decisionModel
  } catch (error) {
    if (error instanceof ProviderError) {
      console.error(error.message)
      console.error("C8 measures real latency and cost, so it needs the real providers.")
      return 1
    }
    throw error
  }

  const limit = Number(flags.get("limit") ?? "0")
  const examples =
    Number.isFinite(limit) && limit > 0 ? loaded.examples.slice(0, limit) : loaded.examples
  const repeats = Math.max(1, Number(flags.get("repeats") ?? "1"))
  const brainCalls = examples.length * repeats * 2
  const decisionCalls = examples.length * repeats

  // This is the expensive script in the repo: two real brain calls per
  // labeled example, because the whole point is measuring what a real
  // brain charges for a longer tool list. So it says what it is about to
  // spend and waits to be told to spend it. `openbox tune` asks a cheap
  // decision model once per example and just runs.
  if (!flags.has("go")) {
    console.log(
      [
        `This would make ${brainCalls} calls to ${brains[0]?.id} (${modelsFromConfig(loaded.config)[0] ?? ""})`,
        `and ${decisionCalls} to ${decisionModel.id}, on ${examples.length} labeled examples${
          repeats > 1 ? ` over ${repeats} passes` : ""
        }.`,
        "",
        "Two brain calls per example is the measurement: one with the tools routing",
        "chose and one with every tool. A fake brain cannot answer the question,",
        "because what routing saves is what a real one charges for a longer list.",
        "",
        "Add --go to run it. --limit <n> measures fewer examples first.",
      ].join("\n"),
    )
    return 0
  }

  console.log(
    `Answering ${examples.length} examples twice each, ${repeats} pass(es). This costs money.`,
  )

  const report = await measureC8({
    brain: brains[0] as Brain,
    model: modelsFromConfig(loaded.config)[0] ?? "",
    decisionModel,
    tools: loaded.tools,
    examples,
    prompt: loaded.prompt,
    config: loaded.config,
    repeats,
    onProgress: (done, total) => {
      if (done % 5 === 0 || done === total) console.log(`  ${done} / ${total}`)
    },
  })

  console.log(`\n${formatC8(report, loaded.config.name)}`)
  return report.pass ? 0 : 1
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
