// SKILL-7 and LEARN-5: `openbox tune`.
//
// Reads the agent in this folder, asks its decision model about every
// labeled example once, and reports where the routing threshold should
// sit. No database and no brain: tuning a dial on the decision model has
// nothing to do with either, and asking for keys it will not use would
// make this a command nobody runs.
//
// LEARN-7 is the rule this command obeys: nothing changes the agent
// without the builder's approval. So it reports, and it edits
// `agent.config.ts` only when asked with `--write`.
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { basename, join } from "node:path"
import { ProviderError, decisionModelFromConfig, type Env } from "../providers/index.ts"
import { loadProject, ProjectError, type LoadProjectOptions } from "./project.ts"
import { stdio, type ChatIo } from "./terminal.ts"
import {
  tune,
  mergeExamples,
  examplesFromTools,
  parseRoutingJsonl,
  ROUTING_EXAMPLES_FILE,
  DEFAULT_TOLERANCE,
  type TuneReport,
  type LabeledExample,
} from "../tune/index.ts"
import type { DecisionModel } from "../providers/decision/types.ts"

export interface TuneOptions extends LoadProjectOptions {
  env?: Env | undefined
  io?: ChatIo | undefined
  /** Used as given, so a test needs no key and no network (DEP-3). */
  decisionModel?: DecisionModel | undefined
  /** The share of examples that may lose their tool. Default 1 in 100. */
  tolerance?: number | undefined
  /** Where the labeled set lives. Defaults to examples/routing.jsonl. */
  examplesFile?: string | undefined
  /** LEARN-7: config is edited only when this is asked for. */
  write?: boolean | undefined
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`
const tools = (count: number): string => `${count} tool${count === 1 ? "" : "s"}`
const threeDecimals = (value: number): string => value.toFixed(2)

/**
 * The rows worth printing out of 101.
 *
 * The deciles, so the shape of the trade is visible, plus the two numbers
 * the builder actually has to compare: where config sits and what is
 * recommended.
 */
function rowsToShow(report: TuneReport): number[] {
  const wanted = new Set<number>()
  for (let tenth = 1; tenth <= 9; tenth++) wanted.add(tenth / 10)
  wanted.add(Number(report.current.threshold.toFixed(2)))
  if (report.recommended !== undefined) {
    wanted.add(Number(report.recommended.threshold.toFixed(2)))
  }
  return [...wanted].sort((a, b) => a - b)
}

export function formatReport(report: TuneReport, name: string): string {
  const lines: string[] = []
  const at = (threshold: number) =>
    report.curve.find((row) => Math.abs(row.threshold - threshold) < 0.005)

  lines.push(`openbox tune - ${name}`)
  lines.push("")
  lines.push(`Decision model   ${report.model}`)
  lines.push(
    `Examples         ${report.examples} answered (${report.positives} say which tool, ${report.negatives} say which tool not)`,
  )
  lines.push(
    `Requests         ${report.requests}, ${report.costUsd.toFixed(5)} USD${
      report.requests < report.examples
        ? ` (${report.examples - report.requests} examples shared an answer with another)`
        : ""
    }`,
  )
  if (report.failures.length > 0) {
    lines.push(`Not answered     ${report.failures.length}, left out of every number below`)
    for (const failure of report.failures.slice(0, 3)) {
      lines.push(`                 ${failure.where}: ${failure.error}`)
    }
  }
  lines.push("")
  lines.push(
    `Top pick was the labeled tool    ${report.topPickCorrect} / ${report.positives}  (${percent(report.topPickRate)})`,
  )
  lines.push(
    `Picked a tool its own example warned against   ${report.pickedWarnedAgainst} / ${report.negatives}`,
  )
  // C8's first bar. Structurally true, and checked anyway.
  lines.push(`Answered with a tool that does not exist      ${report.invented}`)
  lines.push("")
  lines.push("threshold   narrows   right tool shown   tools shown")
  for (const threshold of rowsToShow(report)) {
    const row = at(threshold)
    if (row === undefined) continue
    const marks: string[] = []
    if (Math.abs(threshold - report.current.threshold) < 0.005) marks.push("config")
    if (
      report.recommended !== undefined &&
      Math.abs(threshold - report.recommended.threshold) < 0.005
    ) {
      marks.push("recommended")
    }
    lines.push(
      [
        `    ${threeDecimals(row.threshold)}`,
        percent(row.narrowRate).padStart(9),
        percent(1 - row.missRate).padStart(18),
        row.meanExposed.toFixed(1).padStart(13),
        marks.length > 0 ? `  <- ${marks.join(", ")}` : "",
      ].join(""),
    )
  }
  lines.push("")

  if (report.recommended === undefined) {
    lines.push(
      `No threshold keeps misses at or under ${percent(report.tolerance)} on this set.`,
      "",
      "That is a real answer, not a failure to find one. On these examples this",
      "decision model cannot narrow this tool list without sometimes hiding the",
      "tool that was needed. Two ways forward, and both are yours to choose:",
      "",
      `  Raise routingMinTools above ${report.examples > 0 ? "your tool count" : "0"}, which switches routing off and`,
      "  leaves every turn paying full price but never losing a tool.",
      "",
      "  Loosen --tolerance, if a miss now and then is worth the saving. Run it",
      "  again with a number and see what the trade looks like.",
    )
    return lines.join("\n")
  }

  const recommended = report.recommended
  const current = report.current
  lines.push(`Recommended: routeThreshold ${threeDecimals(recommended.threshold)}`)
  lines.push(
    `  Narrows ${percent(recommended.narrowRate)} of turns, shows the right tool ${percent(1 - recommended.missRate)} of the time.`,
  )
  // A threshold that narrows nothing is not a tuned threshold. It is
  // routing switched off while still being paid for, one request a step,
  // and the report has to say so rather than let a number look like a win.
  if (recommended.narrowRate < 0.05) {
    lines.push("")
    lines.push(
      "  Read that again: at that threshold routing almost never narrows anything.",
      "  So it would ask the decision model on every step and change nothing, which",
      "  is worse than not routing at all.",
      "",
      `  On these examples ${report.model} cannot pick well enough to be worth asking.`,
      "  Raise routingMinTools above your tool count to switch routing off, or add",
      "  more labeled examples and run this again. A set this size can be unlucky.",
    )
    return lines.join("\n")
  }

  if (Math.abs(recommended.threshold - current.threshold) < 0.005) {
    lines.push("  Which is what your config already says. Nothing to change.")
  } else {
    lines.push(
      `  Your config says ${threeDecimals(current.threshold)}: narrows ${percent(current.narrowRate)}, shows the right tool ${percent(1 - current.missRate)}.`,
    )
    lines.push("")
    lines.push("Add --write to set it in agent.config.ts.")
  }
  return lines.join("\n")
}

/**
 * Sets `routeThreshold` in the project's config file.
 *
 * A replacement of one number, and nothing else. If the field is not there
 * it refuses and prints the line to add rather than guessing where in a
 * hand written config an object should gain a key. Rewriting a builder's
 * config file is not worth saving them one paste.
 */
export function writeThreshold(
  source: string,
  threshold: number,
): { ok: true; text: string } | { ok: false; why: string } {
  const field = /routeThreshold\s*:\s*[0-9]*\.?[0-9]+/g
  const found = source.match(field)

  if (found === null) {
    return {
      ok: false,
      why: `routeThreshold is not in the file, so there is no number to replace. Add it to decisionModel yourself:\n\n    routeThreshold: ${threeDecimals(threshold)},`,
    }
  }
  if (found.length > 1) {
    return {
      ok: false,
      why: `routeThreshold appears ${found.length} times in the file, and I will not guess which one is the setting. Change it by hand to ${threeDecimals(threshold)}.`,
    }
  }

  return { ok: true, text: source.replace(field, `routeThreshold: ${threeDecimals(threshold)}`) }
}

export async function runTune(options: TuneOptions = {}): Promise<number> {
  const io = options.io ?? stdio()
  const env = options.env ?? process.env

  let project: Awaited<ReturnType<typeof loadProject>>
  try {
    project = await loadProject(options)
  } catch (error) {
    if (error instanceof ProjectError) {
      io.write(`${error.message}\n`)
      return 1
    }
    throw error
  }

  const names = project.tools.map((tool) => tool.name)
  if (project.tools.length === 0) {
    io.write("This agent has no tools, so there is no routing to tune.\n")
    return 1
  }

  // ROUTE-1: routing only runs above routingMinTools agent tools. Below
  // it there is no threshold in use, so measuring one would mean paying
  // for requests about a decision this agent never makes.
  const minTools = project.config.routingMinTools
  if (project.tools.length <= minTools) {
    io.write(
      [
        `This agent has ${tools(project.tools.length)} and routingMinTools is ${minTools},`,
        "so routing never runs and routeThreshold is never read. Nothing to tune.",
        "",
        "That is the right setting for a small agent: the brain can choose well",
        `from ${tools(project.tools.length)}, and routing would cost a request to save nothing.`,
        "",
        "Run this again when the agent has more tools, or lower routingMinTools",
        "if you want routing on at this size.",
        "",
      ].join("\n"),
    )
    return 0
  }

  let decisionModel: DecisionModel
  try {
    decisionModel = options.decisionModel ?? decisionModelFromConfig(project.config, env)
  } catch (error) {
    if (error instanceof ProviderError) {
      io.write(`${error.message}\n`)
      io.write("Set the missing key, then run openbox tune again.\n")
      return 1
    }
    throw error
  }

  // The file is optional: a new agent has none, and its tools' own
  // examples are enough to tune on.
  const path = options.examplesFile ?? join(project.dir, ROUTING_EXAMPLES_FILE)
  let fromFile: LabeledExample[] = []
  if (existsSync(path)) {
    const parsed = parseRoutingJsonl(readFileSync(path, "utf8"), path, names)
    if (parsed.problems.length > 0) {
      io.write(`${ROUTING_EXAMPLES_FILE} has problems, and none of it was used:\n`)
      for (const problem of parsed.problems) io.write(`  - ${problem}\n`)
      return 1
    }
    fromFile = parsed.examples
  }

  const examples = mergeExamples(examplesFromTools(project.tools), fromFile)
  if (examples.length === 0) {
    io.write("No labeled examples, so there is nothing to measure.\n")
    return 1
  }

  io.write(
    `Asking ${decisionModel.id} about ${examples.length} labeled examples. This costs money.\n`,
  )

  const report = await tune({
    decisionModel,
    tools: project.tools,
    examples,
    current: project.config.decisionModel.routeThreshold,
    tolerance: options.tolerance ?? DEFAULT_TOLERANCE,
    timeoutMs: project.config.decisionTimeoutMs,
  })

  if (report.examples === 0) {
    io.write("\nNothing was answered, so there is no measurement.\n")
    for (const failure of report.failures.slice(0, 5)) {
      io.write(`  ${failure.where}: ${failure.error}\n`)
    }
    return 1
  }

  io.write(`\n${formatReport(report, project.config.name)}\n`)

  if (options.write !== true || report.recommended === undefined) return 0

  const configPath = project.files.config
  const result = writeThreshold(readFileSync(configPath, "utf8"), report.recommended.threshold)
  if (!result.ok) {
    io.write(`\nNot written. ${result.why}\n`)
    return 1
  }
  writeFileSync(configPath, result.text)
  io.write(
    `\nSet routeThreshold to ${threeDecimals(report.recommended.threshold)} in ${basename(configPath)}.\n`,
  )
  return 0
}
