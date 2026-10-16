// CFG-1: the config is checked before the agent starts, and every problem
// is reported at once. The builder is not a developer, so one pass that
// lists everything beats a stack trace per mistake.
import { z } from "zod"
import { configSchema, type OpenboxConfig, type OpenboxConfigInput } from "./schema.ts"
import { findSecrets } from "./secrets.ts"
import { isCliBrain } from "./providers.ts"

export { configSchema, type OpenboxConfig, type OpenboxConfigInput } from "./schema.ts"
export * from "./providers.ts"

/** Every problem found in a config, in one error. */
export class ConfigError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    const list = problems.map((problem) => `  - ${problem}`).join("\n")
    super(`This agent's config cannot be used:\n${list}`)
    this.name = "ConfigError"
    this.problems = problems
  }
}

/** Turns a zod issue into lines a builder can act on, one per problem. */
function describe(issue: z.core.$ZodIssue): string[] {
  const path = issue.path.join(".")
  if (issue.code === "invalid_type" && issue.input === undefined) {
    return [`${path}: required, but missing`]
  }
  if (issue.code === "invalid_value" || issue.code === "invalid_union") {
    const options = "values" in issue ? issue.values : undefined
    if (Array.isArray(options) && options.length > 0) {
      return [`${path}: unknown value. Use one of: ${options.join(", ")}`]
    }
  }
  if (issue.code === "unrecognized_keys") {
    const here = path === "" ? "" : `${path}.`
    return issue.keys.map((key) => `${here}${key}: not a config field. Check the spelling`)
  }
  return [path === "" ? issue.message : `${path}: ${issue.message}`]
}

/**
 * Validates a config and fills in the documented defaults.
 *
 * Throws `ConfigError` listing everything wrong. What it cannot see is the
 * tool registry, so CFG-1's rule about an irreversible tool needing a
 * `confirmSummary` is checked by `createAgent` instead.
 */
export function defineConfig(input: OpenboxConfigInput): OpenboxConfig
export function defineConfig(input: unknown): OpenboxConfig
export function defineConfig(input: unknown): OpenboxConfig {
  const problems: string[] = []

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigError(["the config must be an object, as `defineConfig({ ... })`"])
  }

  // CFG-2 first, so a credential is named precisely rather than appearing
  // as an unrecognised field.
  const secretPaths = new Set(findSecrets(input))
  for (const path of secretPaths) {
    problems.push(`${path}: secrets never go in config. Providers read keys from the environment`)
  }

  const result = configSchema.safeParse(input)
  if (!result.success) {
    for (const issue of result.error.issues) {
      for (const line of describe(issue)) {
        // A credential already reported above needs no second mention as
        // an unrecognised field.
        if (secretPaths.has(line.slice(0, line.indexOf(":")))) continue
        if (!problems.includes(line)) problems.push(line)
      }
    }
  }

  // Read from the raw input rather than the parsed config, so this still
  // reports when something unrelated failed to parse. One pass should tell
  // the builder everything that is wrong.
  problems.push(...crossFieldProblems(input))

  if (problems.length > 0) throw new ConfigError(problems)
  return result.data as OpenboxConfig
}

/** Reads a nested field without assuming anything above it parsed. */
function at(value: unknown, ...path: string[]): unknown {
  let here = value
  for (const step of path) {
    if (here === null || typeof here !== "object") return undefined
    here = (here as Record<string, unknown>)[step]
  }
  return here
}

/** Rules that need more than one field to judge. */
function crossFieldProblems(input: unknown): string[] {
  const problems: string[] = []

  // BRAIN-4: CLI brains drive a CLI on the machine, so they are for
  // building and local testing only.
  if (at(input, "mode") === "production") {
    const fallbacks = at(input, "brain", "fallbacks")
    const ids = [
      at(input, "brain", "id"),
      ...(Array.isArray(fallbacks) ? fallbacks.map((brain) => at(brain, "id")) : []),
    ]

    for (const id of new Set(ids)) {
      if (typeof id === "string" && isCliBrain(id)) {
        problems.push(`brain: ${id} is a CLI brain and cannot run in production (BRAIN-4)`)
      }
    }
  }

  return problems
}
