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
    const { brains } = providersFromConfig(config(), { brains: [fake] }, {})

    expect(brains).toEqual([fake])
  })

  test("DEP-3: the primary brain comes first, then the fallbacks in order", () => {
    const primary = scriptedBrain([], { id: "primary" })
    const second = scriptedBrain([], { id: "second" })
    const { brains } = providersFromConfig(config(), { brains: [primary, second] }, {})

    expect(brains.map((brain) => brain.id)).toEqual(["primary", "second"])
  })

  test("DEP-3: an empty list of brains is refused, since nothing could answer", () => {
    expect(() => providersFromConfig(config(), { brains: [] }, {})).toThrow(/empty/)
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
