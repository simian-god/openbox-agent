// DEP-3: `providersFromConfig` builds the dependencies from config,
// reading keys from the environment. Tests and evals-agent pass their own
// instances instead, and those win.
//
// CFG-2 is why the keys come from here and not from config.
import type { OpenboxConfig } from "../config/index.ts"
import type { Brain } from "./brains/types.ts"
import { openRouterBrain } from "./brains/openrouter.ts"

export * from "./brains/types.ts"
export { openRouterBrain, toWireMessages, readResponse } from "./brains/openrouter.ts"

/** Where a provider's key is read from. Also the list in .env.example. */
export const ENV_KEYS = {
  openrouter: "OPENROUTER_API_KEY",
  "claude-agent-sdk": "ANTHROPIC_API_KEY",
  "openai-agents": "OPENAI_API_KEY",
} as const

/** Raised when config names a provider that cannot be built. */
export class ProviderError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    const list = problems.map((problem) => `  - ${problem}`).join("\n")
    super(`This agent's providers cannot be built:\n${list}`)
    this.name = "ProviderError"
    this.problems = problems
  }
}

/** The environment, injectable so a test need not touch the real one. */
export type Env = Record<string, string | undefined>

export interface ProvidersOverride {
  /** Used as given. The first is the primary, the rest are fallbacks. */
  brains?: Brain[] | undefined
}

export interface BuiltProviders {
  brains: Brain[]
}

/** One brain from a config entry, or a problem explaining why not. */
function buildBrain(id: string, env: Env, problems: string[]): Brain | undefined {
  switch (id) {
    case "openrouter": {
      const apiKey = env[ENV_KEYS.openrouter]
      if (apiKey === undefined || apiKey === "") {
        problems.push(
          `brain openrouter needs ${ENV_KEYS.openrouter} in the environment. Secrets never go in config (CFG-2)`,
        )
        return undefined
      }
      return openRouterBrain({ apiKey })
    }
    default:
      // The other four brains arrive in M5. Config already rejects an id
      // that is not one of the five (CFG-1), so this is a gap in the
      // build, not a typo by the builder.
      problems.push(`brain ${id} is named in config but its adapter is not built yet`)
      return undefined
  }
}

/**
 * Builds the providers an agent needs from its config.
 *
 * Anything passed in `override` is used as it stands, so tests and
 * evals-agent never need a key, and the environment is never read for it.
 */
export function providersFromConfig(
  config: OpenboxConfig,
  override: ProvidersOverride = {},
  env: Env = process.env,
): BuiltProviders {
  const problems: string[] = []

  let brains: Brain[]
  if (override.brains !== undefined) {
    if (override.brains.length === 0) {
      throw new ProviderError(["brains was given as an empty list, so nothing can answer a turn"])
    }
    brains = override.brains
  } else {
    const wanted = [config.brain, ...config.brain.fallbacks]
    brains = wanted
      .map((entry) => buildBrain(entry.id, env, problems))
      .filter((brain): brain is Brain => brain !== undefined)
  }

  if (problems.length > 0) throw new ProviderError(problems)

  return { brains }
}

/** The model each brain should be called with, in the same order. */
export function modelsFromConfig(config: OpenboxConfig): string[] {
  return [config.brain, ...config.brain.fallbacks].map((entry) => entry.model)
}
