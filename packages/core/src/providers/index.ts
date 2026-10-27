// DEP-3: `providersFromConfig` builds the dependencies from config,
// reading keys from the environment. Tests and evals-agent pass their own
// instances instead, and those win.
//
// CFG-2 is why the keys come from here and not from config.
// A blank variable counts as unset, so a key pasted with a stray space
// is refused here with the message below rather than at the vendor.
import { envValue } from "../env.ts"
import type { OpenboxConfig } from "../config/index.ts"
import type { Brain } from "./brains/types.ts"
import { openRouterBrain } from "./brains/openrouter.ts"
import { claudeAgentSdkBrain } from "./brains/claude-agent-sdk.ts"
import { claudeCodeCliBrain, codexCliBrain } from "./brains/cli.ts"
import type { DecisionModel } from "./decision/types.ts"
import { jevDecisionModel, type JevRoute } from "./decision/jev.ts"
import { openaiDecisionsModel } from "./decision/openai-decisions.ts"

export * from "./brains/types.ts"
export { openRouterBrain, toWireMessages, readResponse } from "./brains/openrouter.ts"
export {
  claudeCodeCliBrain,
  codexCliBrain,
  runCommand,
  unwrap,
  DEFAULT_CLAUDE_CLI_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CLI_TIMEOUT_MS,
  type CliBrainOptions,
  type RunCommand,
  type RunResult,
} from "./brains/cli.ts"
export {
  claudeAgentSdkBrain,
  DEFAULT_CLAUDE_MODEL,
  type ClaudeAgentSdkOptions,
  type SdkQuery,
} from "./brains/claude-agent-sdk.ts"
export {
  structuredBrain,
  structuredSchema,
  structuredInstructions,
  toTranscript,
  readStructured,
  extractObject,
  REPLY,
  TOOL,
  type StructuredOptions,
  type StructuredRequest,
  type StructuredAnswer,
  type Read,
} from "./brains/structured.ts"
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
  // BRAIN-1: `claude --bare` says "Anthropic auth is strictly
  // ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain are never
  // read)", so this brain needs a key and does not run on a logged in
  // subscription.
  "claude-code-cli": "ANTHROPIC_API_KEY",
  // Codex is the other way round: it keeps its own login, and a key is
  // only used when one is there. Reflected rather than made uniform,
  // because that is what the two commands actually do.
  "codex-cli": "OPENAI_API_KEY",
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
      const apiKey = envValue(ENV_KEYS.openrouter, env)
      if (apiKey === undefined) {
        problems.push(
          `brain openrouter needs ${ENV_KEYS.openrouter} in the environment. Secrets never go in config (CFG-2)`,
        )
        return undefined
      }
      return openRouterBrain({ apiKey })
    }

    case "claude-agent-sdk": {
      const apiKey = envValue(ENV_KEYS["claude-agent-sdk"], env)
      if (apiKey === undefined) {
        problems.push(
          `brain claude-agent-sdk needs ${ENV_KEYS["claude-agent-sdk"]} in the environment. Secrets never go in config (CFG-2)`,
        )
        return undefined
      }
      return claudeAgentSdkBrain({ apiKey })
    }

    case "claude-code-cli": {
      const apiKey = envValue(ENV_KEYS["claude-code-cli"], env)
      if (apiKey === undefined) {
        problems.push(
          `brain claude-code-cli needs ${ENV_KEYS["claude-code-cli"]} in the environment. It runs \`claude --bare\`, which never reads a logged in session (BRAIN-1)`,
        )
        return undefined
      }
      return claudeCodeCliBrain({ apiKey })
    }

    case "codex-cli":
      // No key required: Codex keeps its own login, and one is passed only
      // when it is there.
      return codexCliBrain({ apiKey: envValue(ENV_KEYS["codex-cli"], env) ?? "" })

    default:
      // The OpenAI Agents SDK is parked, see Known K16. Config already rejects an id
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
      const apiKey = envValue(key, env)
      if (apiKey === undefined) {
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
      const apiKey = envValue(ENV_KEYS["openai-agents"], env)
      if (apiKey === undefined) {
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
