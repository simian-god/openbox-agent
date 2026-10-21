// DEP-3 has three parts: build from config, let passed in instances win,
// and record which providers actually ran on each turn. The first two are
// proven here. The third needs a turn, so it lands with T1.6 and T1.7.
import { test, expect, describe } from "bun:test"
import {
  providersFromConfig,
  modelsFromConfig,
  ProviderError,
  ENV_KEYS,
} from "../../src/providers/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { scriptedBrain } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel } from "../../src/testing/scripted-decision.ts"

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: [["11:00", "23:00"]] },
    brain: { id: "openrouter", model: "some/model" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages.",
    retentionDays: 365,
    ...over,
  })
}

describe("DEP-3: building providers from config", () => {
  test("DEP-3: the brain named in config is built, with its key from the environment", () => {
    const { brains } = providersFromConfig(config(), {}, { [ENV_KEYS.openrouter]: "sk-test" })

    expect(brains).toHaveLength(1)
    expect(brains[0]?.id).toBe("openrouter")
  })

  test("CFG-2: a missing key is a clear error naming the variable to set", () => {
    let problems: string[] = []
    try {
      providersFromConfig(config(), {}, {})
    } catch (error) {
      problems = (error as ProviderError).problems
    }

    expect(problems.join("\n")).toContain(ENV_KEYS.openrouter)
    expect(problems.join("\n")).toContain("environment")
  })

  test("CFG-2: an empty key counts as missing, not as a key", () => {
    expect(() => providersFromConfig(config(), {}, { [ENV_KEYS.openrouter]: "" })).toThrow(
      ProviderError,
    )
  })

  test("DEP-3: brains passed in win, and the environment is never read", () => {
    const fake = scriptedBrain([{ reply: "hi" }])
    // No key in the environment at all: this must still work.
    const decisionModel = scriptedDecisionModel([])
    const { brains } = providersFromConfig(config(), { brains: [fake], decisionModel }, {})

    expect(brains).toEqual([fake])
  })

  test("DEP-3: the primary brain comes first, then the fallbacks in order", () => {
    const primary = scriptedBrain([], { id: "primary" })
    const second = scriptedBrain([], { id: "second" })
    const { brains } = providersFromConfig(
      config(),
      { brains: [primary, second], decisionModel: scriptedDecisionModel([]) },
      {},
    )

    expect(brains.map((brain) => brain.id)).toEqual(["primary", "second"])
  })

  test("DEP-3: an empty list of brains is refused, since nothing could answer", () => {
    expect(() =>
      providersFromConfig(config(), { brains: [], decisionModel: scriptedDecisionModel([]) }, {}),
    ).toThrow(/empty/)
  })

  test("DEP-3: a brain whose adapter is not built yet is named plainly", () => {
    const withFallback = config({
      brain: {
        id: "openrouter",
        model: "a/b",
        fallbacks: [{ id: "openai-agents", model: "c/d" }],
      },
    })

    let problems: string[] = []
    try {
      providersFromConfig(withFallback, {}, { [ENV_KEYS.openrouter]: "sk-test" })
    } catch (error) {
      problems = (error as ProviderError).problems
    }
    expect(problems.join("\n")).toContain("openai-agents")
    expect(problems.join("\n")).toContain("not built yet")
  })

  test("DEP-3: the model for each brain comes from config, in the same order", () => {
    const withFallback = config({
      brain: { id: "openrouter", model: "a/b", fallbacks: [{ id: "openai-agents", model: "c/d" }] },
    })

    expect(modelsFromConfig(withFallback)).toEqual(["a/b", "c/d"])
  })
})

describe("DM-1: building the decision model from config", () => {
  const keys = (over: Record<string, string>) => ({ [ENV_KEYS.openrouter]: "sk-or", ...over })

  test("DM-1: jev defaults to the OpenRouter route, which is the one that is open", () => {
    const { decisionModel } = providersFromConfig(config(), {}, keys({}))

    expect(decisionModel.id).toBe("jev")
  })

  test("DM-1: the route in config decides which key is read", () => {
    // The whole reason the route is named rather than guessed: a TypeSafe
    // key must never be posted to OpenRouter.
    const onTypeSafe = config({ decisionModel: { id: "jev", route: "typesafe" } })

    let problems: string[] = []
    try {
      providersFromConfig(onTypeSafe, {}, keys({}))
    } catch (error) {
      problems = (error as ProviderError).problems
    }
    // The OpenRouter key is present and is not accepted for this route.
    expect(problems.join(" / ")).toContain(ENV_KEYS.typesafe)

    const built = providersFromConfig(onTypeSafe, {}, keys({ [ENV_KEYS.typesafe]: "ts-key" }))
    expect(built.decisionModel.id).toBe("jev")
  })

  test("DM-1: the OpenAI decisions model reads the OpenAI key", () => {
    const openai = config({ decisionModel: { id: "openai-decisions" } })

    let problems: string[] = []
    try {
      providersFromConfig(openai, {}, keys({}))
    } catch (error) {
      problems = (error as ProviderError).problems
    }
    expect(problems.join(" / ")).toContain(ENV_KEYS["openai-agents"])

    const built = providersFromConfig(
      openai,
      {},
      keys({ [ENV_KEYS["openai-agents"]]: "sk-openai" }),
    )
    expect(built.decisionModel.id).toBe("openai-decisions")
  })

  test("DM-1: a route on a model that has only one is refused by config", () => {
    expect(() =>
      config({ decisionModel: { id: "openai-decisions", route: "openrouter" } }),
    ).toThrow(/only one route/)
  })

  test("DM-1: a decision model passed in wins, and no key is read for it", () => {
    const fake = scriptedDecisionModel([])
    const { decisionModel } = providersFromConfig(
      config(),
      { brains: [scriptedBrain([])], decisionModel: fake },
      {},
    )

    expect(decisionModel).toBe(fake)
  })

  test("CFG-2: a missing decision model key is reported with the brain's, in one pass", () => {
    let problems: string[] = []
    try {
      providersFromConfig(config(), {}, {})
    } catch (error) {
      problems = (error as ProviderError).problems
    }

    // One run tells the builder everything that is missing.
    expect(problems).toHaveLength(2)
    expect(problems.join(" / ")).toContain("brain openrouter")
    expect(problems.join(" / ")).toContain("decision model jev")
  })
})
