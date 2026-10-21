// DEP-3: `providersFromConfig` builds the dependencies from config,
// reading keys from the environment. Tests and evals-agent pass their own
// instances instead, and those win.
//
// CFG-2 is why the keys come from here and not from config.
import type { OpenboxConfig } from "../config/index.ts"
import type { Brain } from "./brains/types.ts"
import { openRouterBrain } from "./brains/openrouter.ts"
import type { DecisionModel } from "./decision/types.ts"
import { jevDecisionModel, type JevRoute } from "./decision/jev.ts"
import { openaiDecisionsModel } from "./decision/openai-decisions.ts"

export * from "./brains/types.ts"
export { openRouterBrain, toWireMessages, readResponse } from "./brains/openrouter.ts"
export { supabaseFromEnv, DB_ENV_KEYS } from "./db.ts"
export type { FetchLike } from "./http.ts"
export * from "./decision/types.ts"
export { jevDecisionModel, JEV_ROUTES, type JevRoute, type JevOptions } from "./decision/jev.ts"
export {
  openaiDecisionsModel,
  type OpenaiDecisionsOptions,
} from "./decision/openai-decisions.ts"

/** Where a provider's key is read from. Also the list in .env.example. */
export const ENV_KEYS = {
  openrouter: "OPENROUTER_API_KEY",
  "claude-agent-sdk": "ANTHROPIC_API_KEY",
  "openai-agents": "OPENAI_API_KEY",
  // Jev's own route. Jev through OpenRouter uses the OpenRouter key above.
  typesafe: "TYPESAFE_API_KEY",
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
  /** Used as given, so a test or evals-agent never needs a key. */
  decisionModel?: DecisionModel | undefined
}

export interface BuiltProviders {
  brains: Brain[]
  decisionModel: DecisionModel
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

/** One decision model from config, or a problem explaining why not. */
function buildDecisionModel(
  config: OpenboxConfig,
  env: Env,
  problems: string[],
): DecisionModel | undefined {
  const wanted = config.decisionModel

  switch (wanted.id) {
    case "jev": {
      // DM-1: config names the route, and the route decides which key is
      // read. That is what stops one vendor's key reaching another.
      const route = (wanted.route ?? "openrouter") as JevRoute
      const key = route === "typesafe" ? ENV_KEYS.typesafe : ENV_KEYS.openrouter
      const apiKey = env[key]
      if (apiKey === undefined || apiKey === "") {
        problems.push(
          `decision model jev on the ${route} route needs ${key} in the environment. Secrets never go in config (CFG-2)`,
        )
        return undefined
      }
      return jevDecisionModel({
        apiKey,
        route,
        ...(wanted.model !== undefined ? { model: wanted.model } : {}),
      })
    }

    case "openai-decisions": {
      const apiKey = env[ENV_KEYS["openai-agents"]]
      if (apiKey === undefined || apiKey === "") {
        problems.push(
          `decision model openai-decisions needs ${ENV_KEYS["openai-agents"]} in the environment. Secrets never go in config (CFG-2)`,
        )
        return undefined
      }
      return openaiDecisionsModel({
        apiKey,
        ...(wanted.model !== undefined ? { model: wanted.model } : {}),
      })
    }
  }
}

/**
 * Just the decision model, for a command that needs nothing else.
 *
 * `openbox tune` measures a dial on the decision model. It never calls a
 * brain and never opens the database, so asking for their keys would make
 * it a command that fails for reasons that have nothing to do with it.
 */
export function decisionModelFromConfig(
  config: OpenboxConfig,
  env: Env = process.env,
): DecisionModel {
  const problems: string[] = []
  const built = buildDecisionModel(config, env, problems)
  if (built === undefined) throw new ProviderError(problems)
  return built
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

  let decisionModel: DecisionModel | undefined
  if (override.decisionModel !== undefined) {
    decisionModel = override.decisionModel
  } else {
    decisionModel = buildDecisionModel(config, env, problems)
  }

  if (problems.length > 0) throw new ProviderError(problems)

  return { brains, decisionModel: decisionModel as DecisionModel }
}

/** The model each brain should be called with, in the same order. */
export function modelsFromConfig(config: OpenboxConfig): string[] {
  return [config.brain, ...config.brain.fallbacks].map((entry) => entry.model)
}
