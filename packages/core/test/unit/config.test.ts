import { test, expect, describe } from "bun:test"
import { defineConfig, ConfigError } from "../../src/config/index.ts"

/** A config with every required field and nothing else, for tests to bend. */
function validInput(): Record<string, unknown> {
  return {
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: [["11:00", "23:00"]] },
    brain: { id: "openrouter", model: "some/model" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages to answer you.",
    retentionDays: 365,
    builderChannel: { channel: "telegram", channelUserId: "12345" },
  }
}

/** The problems reported, as one string, so a test can look for a phrase. */
function problems(input: unknown): string {
  try {
    defineConfig(input)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems.join("\n")
    throw error
  }
  throw new Error("expected the config to be rejected, but it was accepted")
}

describe("required fields", () => {
  test("CFG-1: a valid config is accepted", () => {
    const config = defineConfig(validInput())
    expect(config.name).toBe("restaurant")
    expect(config.limits.dailySpendUsd).toBe(5)
  })

  test("CFG-1: rejects a config with no spend cap", () => {
    const input = validInput()
    input["limits"] = {}
    expect(problems(input)).toContain("limits.dailySpendUsd")
  })

  test("CFG-1: rejects a config with no limits at all", () => {
    const input = validInput()
    delete input["limits"]
    expect(problems(input)).toContain("limits")
  })

  test("CFG-1: the spend cap has no default, so zero is kept and not filled in", () => {
    const input = validInput()
    input["limits"] = { dailySpendUsd: 0 }
    expect(defineConfig(input).limits.dailySpendUsd).toBe(0)
  })

  // PRIV-1 also depends on this: the notice must exist before it can be shown.
  test("CFG-1: a config without notice text fails to load", () => {
    const input = validInput()
    delete input["notice"]
    expect(problems(input)).toContain("notice")
  })

  test("CFG-1: an empty notice is not a notice", () => {
    const input = validInput()
    input["notice"] = "   "
    expect(problems(input)).toContain("notice")
  })

  // PRIV-2's retention job is built in M9; this only proves the field is required.
  test("CFG-1: the retention period is required", () => {
    const input = validInput()
    delete input["retentionDays"]
    expect(problems(input)).toContain("retentionDays")
  })
})

describe("provider ids", () => {
  test("CFG-1: rejects an unknown brain id", () => {
    const input = validInput()
    input["brain"] = { id: "gpt-9000", model: "x" }
    const reported = problems(input)
    expect(reported).toContain("brain.id")
    // The message names the ids that do work, so the builder can fix it.
    expect(reported).toContain("openrouter")
  })

  test("CFG-1: rejects an unknown decision model id", () => {
    const input = validInput()
    input["decisionModel"] = { id: "guesswork" }
    expect(problems(input)).toContain("decisionModel.id")
  })

  test("CFG-1: rejects an unknown retriever id", () => {
    const input = validInput()
    input["retriever"] = { id: "grep" }
    expect(problems(input)).toContain("retriever.id")
  })

  test("CFG-1: rejects an unknown transcriber id", () => {
    const input = validInput()
    input["transcriber"] = { id: "ears" }
    expect(problems(input)).toContain("transcriber.id")
  })

  test("CFG-1: rejects an unknown fallback brain id", () => {
    const input = validInput()
    input["brain"] = { id: "openrouter", model: "x", fallbacks: [{ id: "nope", model: "y" }] }
    expect(problems(input)).toContain("brain.fallbacks")
  })
})

describe("CLI brains", () => {
  // BRAIN-4 is proven properly in M5. Config can only catch it at start.
  test("CFG-1: rejects a CLI brain in production", () => {
    const input = validInput()
    input["mode"] = "production"
    input["brain"] = { id: "claude-code-cli", model: "x" }
    expect(problems(input)).toContain("claude-code-cli")
  })

  test("CFG-1: rejects a CLI brain hidden in the fallbacks in production", () => {
    const input = validInput()
    input["mode"] = "production"
    input["brain"] = { id: "openrouter", model: "x", fallbacks: [{ id: "codex-cli", model: "y" }] }
    expect(problems(input)).toContain("codex-cli")
  })

  test("CFG-1: allows a CLI brain in development", () => {
    const input = validInput()
    input["brain"] = { id: "claude-code-cli", model: "x" }
    expect(defineConfig(input).brain.id).toBe("claude-code-cli")
  })
})

describe("CFG-2: secrets", () => {
  test("CFG-2: rejects an api key in config", () => {
    const input = validInput()
    input["brain"] = { id: "openrouter", model: "x", apiKey: "sk-not-here-please" }
    const reported = problems(input)
    expect(reported).toContain("brain.apiKey")
    expect(reported).toContain("environment")
  })

  test("CFG-2: rejects a secret however deeply it is nested", () => {
    const input = validInput()
    input["decisionModel"] = { id: "jev", options: { auth: { token: "abc" } } }
    expect(problems(input)).toContain("decisionModel.options.auth.token")
  })

  test("CFG-2: the reported value is never the secret itself", () => {
    const input = validInput()
    input["brain"] = { id: "openrouter", model: "x", apiKey: "sk-live-abcdefghijklmnop" }
    expect(problems(input)).not.toContain("sk-live-abcdefghijklmnop")
  })

  test("CFG-2: an innocent field whose name merely contains a word is kept", () => {
    const input = validInput()
    input["taskTypes"] = { booking: { fields: { keyholder: "optional" }, idleHours: 24 } }
    expect(() => defineConfig(input)).not.toThrow()
  })
})

describe("defaults", () => {
  test("CFG-1: the documented defaults are filled in", () => {
    const config = defineConfig(validInput())

    expect(config.history).toBe(30)
    expect(config.burstWindowMs).toBe(3000)
    expect(config.routingMinTools).toBe(5)
    expect(config.maxSteps).toBe(8)
    expect(config.pendingActionMinutes).toBe(15)
    expect(config.limits.messagesPerWindow).toBe(20)
    expect(config.limits.windowMinutes).toBe(10)
    expect(config.handover.noOperatorMinutes).toBe(10)
    expect(config.handover.idleMinutes).toBe(30)
    expect(config.handover.wantsHumanThreshold).toBe(0.8)
    expect(config.decisionModel.routeThreshold).toBe(0.6)
  })

  test("CFG-1: a value given in config beats the default", () => {
    const input = validInput()
    input["maxSteps"] = 3
    input["handover"] = { idleMinutes: 5 }
    const config = defineConfig(input)

    expect(config.maxSteps).toBe(3)
    expect(config.handover.idleMinutes).toBe(5)
    // The rest of the group keeps its defaults.
    expect(config.handover.noOperatorMinutes).toBe(10)
  })
})

describe("values that must make sense", () => {
  test("CFG-1: rejects a timezone that is not a real zone", () => {
    const input = validInput()
    input["timezone"] = "Mars/Olympus"
    expect(problems(input)).toContain("timezone")
  })

  test("CFG-1: rejects opening hours that are not times", () => {
    const input = validInput()
    input["hours"] = { mon: [["11am", "11pm"]] }
    expect(problems(input)).toContain("hours")
  })

  test("CFG-1: rejects an opening range that ends before it starts", () => {
    const input = validInput()
    input["hours"] = { mon: [["23:00", "11:00"]] }
    expect(problems(input)).toContain("hours.mon")
  })

  test("CFG-1: rejects a day that is not a day", () => {
    const input = validInput()
    input["hours"] = { funday: [["11:00", "12:00"]] }
    expect(problems(input)).toContain("hours")
  })

  test("CFG-1: accepts quiet hours that wrap past midnight", () => {
    const input = validInput()
    input["quietHours"] = ["21:00", "09:00"]
    expect(defineConfig(input).quietHours).toEqual(["21:00", "09:00"])
  })

  test("CFG-1: rejects a negative retention period", () => {
    const input = validInput()
    input["retentionDays"] = -1
    expect(problems(input)).toContain("retentionDays")
  })

  test("CFG-1: rejects a spend cap that is not a number", () => {
    const input = validInput()
    input["limits"] = { dailySpendUsd: "five dollars" }
    expect(problems(input)).toContain("limits.dailySpendUsd")
  })

  test("CFG-1: rejects a route threshold outside 0 to 1", () => {
    const input = validInput()
    input["decisionModel"] = { id: "jev", routeThreshold: 1.5 }
    expect(problems(input)).toContain("routeThreshold")
  })

  // GATE-2's banding behaviour is built in M3; these check the config only.
  test("CFG-1: rejects a gate band outside 0 to 1", () => {
    const input = validInput()
    input["decisionModel"] = { id: "jev", gateBands: { book: { pass: 1.2, confirm: 0.4 } } }
    expect(problems(input)).toContain("gateBands")
  })

  test("CFG-1: rejects a gate band whose confirm floor is above its pass floor", () => {
    const input = validInput()
    input["decisionModel"] = { id: "jev", gateBands: { book: { pass: 0.5, confirm: 0.8 } } }
    expect(problems(input)).toContain("gateBands.book")
  })
})

describe("the error itself", () => {
  test("CFG-1: every problem is reported at once, not one at a time", () => {
    const input = validInput()
    delete input["notice"]
    delete input["retentionDays"]
    input["brain"] = { id: "nope", model: "x" }

    const reported = problems(input)
    expect(reported).toContain("notice")
    expect(reported).toContain("retentionDays")
    expect(reported).toContain("brain.id")
  })

  test("CFG-1: a cross field problem is reported alongside a missing field", () => {
    // The CLI brain rule needs two fields to judge, so it must not wait for
    // the rest of the config to parse before it is reported.
    const input = validInput()
    input["mode"] = "production"
    input["brain"] = { id: "codex-cli", model: "x" }
    delete input["notice"]

    const reported = problems(input)
    expect(reported).toContain("notice")
    expect(reported).toContain("codex-cli")
  })

  test("CFG-1: the message says which config it is and what to fix", () => {
    const input = validInput()
    delete input["notice"]

    let message = ""
    try {
      defineConfig(input)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("config")
    expect(message).toContain("notice")
  })

  test("CFG-1: rejects something that is not an object at all", () => {
    expect(() => defineConfig(null)).toThrow(ConfigError)
    expect(() => defineConfig("a config")).toThrow(ConfigError)
  })

  test("CFG-1: rejects a field the Spec does not define, in case it is a typo", () => {
    const input = validInput()
    input["maxStep"] = 4
    expect(problems(input)).toContain("maxStep")
  })
})
