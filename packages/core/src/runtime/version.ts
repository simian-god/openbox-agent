// LEARN-2: the version ID a turn ran under.
//
// A version is a hash of everything that decides how the agent behaves:
// the prompt, each tool as the brain sees it, the config without secrets,
// and the core package version. Two turns with the same hash ran the same
// agent, which is what makes a review of past conversations mean anything.
//
// What is hashed is exactly LEARN-2's list. A tool's `roles` and `examples`
// are deliberately not in it, so moving a tool between roles or rewording
// an example does not start a new version.
import { createHash } from "node:crypto"
import { withoutSecrets } from "../config/secrets.ts"
import type { OpenboxConfig } from "../config/index.ts"
import type { JSONSchema, Risk, Tool, ToolConditions } from "../tools/index.ts"
import type { TableStore, VersionRow } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"
import { isUniqueViolation } from "../store/index.ts"
import { CORE_VERSION } from "../version.ts"

export interface VersionInput {
  /** The static system prompt, prompt.md in a real agent. */
  prompt: string
  tools: readonly Tool[]
  config: OpenboxConfig
  /** Defaults to this package's version. */
  coreVersion?: string | undefined
}

/** One tool, reduced to the parts LEARN-2 names. */
export interface ToolFingerprint {
  name: string
  description: string
  conditions: ToolConditions
  inputSchema: JSONSchema
  risk: Risk
}

export interface VersionFingerprint {
  core: string
  prompt: string
  /** Sorted by name, so the order tools were registered in cannot matter. */
  tools: ToolFingerprint[]
  config: unknown
}

/** Everything the hash is taken over, in a shape a test can read. */
export function versionFingerprint(input: VersionInput): VersionFingerprint {
  const tools = input.tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      conditions: {
        callWhen: tool.conditions.callWhen,
        dontCallWhen: tool.conditions.dontCallWhen,
      },
      inputSchema: tool.inputSchema,
      risk: tool.risk,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return {
    core: input.coreVersion ?? CORE_VERSION,
    prompt: input.prompt,
    tools,
    config: withoutSecrets(input.config),
  }
}

/**
 * JSON with object keys in a fixed order, so writing the same config in a
 * different order does not look like a different agent. Array order is kept,
 * because in a list of conditions the order is part of the meaning.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"

  const parts: string[] = []
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key]
    // Dropped, so a field written as undefined and a field left out match.
    if (child === undefined) continue
    parts.push(`${JSON.stringify(key)}:${stableStringify(child)}`)
  }
  return `{${parts.join(",")}}`
}

/** LEARN-2: the version ID itself. */
export function versionHash(input: VersionInput): string {
  return createHash("sha256")
    .update(stableStringify(versionFingerprint(input)))
    .digest("hex")
}

export interface VersionStore {
  versions: Pick<TableStore<VersionRow>, "find" | "insert">
}

/**
 * The row for this hash, created the first time it is seen.
 *
 * Two processes starting at once both try to insert, so the unique key on
 * (agent_id, hash) decides and the loser reads what the winner wrote.
 */
export async function ensureVersionRow(options: {
  store: VersionStore
  hash: string
  clock: Clock
}): Promise<VersionRow> {
  const { store, hash, clock } = options

  const existing = await store.versions.find({ hash })
  if (existing !== null) return existing

  try {
    return await store.versions.insert({
      hash,
      // TIME-1: the injected clock, not the database's now().
      first_seen_at: clock.now().toISOString(),
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const found = await store.versions.find({ hash })
    if (found === null) throw error
    return found
  }
}
