// DEP-3 has three parts: build from config, let passed in instances win,
// and record which providers actually ran on each turn. The first two are
// proven here. The third needs a turn, so it lands with T1.6 and T1.7.
import { test, expect, describe } from "bun:test"
import {
  providersFromConfig,
  modelsFromConfig,
  ProviderError,
  ENV_KEYS,
  supabaseFromEnv,
  DB_ENV_KEYS,
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

  test("C2: every brain that ships is built by naming it in config", () => {
    // The offline half of C2: "switching by config only". The live
    // conformance run proves the four brains behave; nothing proved that
    // config alone reaches all four of them, which the M5 check turned up.
    //
    // `codex-cli` takes no key on purpose: it keeps its own login, and one
    // is passed only when it is there (BRAIN-1).
    const ships = [
      { id: "openrouter", env: { [ENV_KEYS.openrouter]: "sk-or" }, kind: "api" },
      { id: "claude-agent-sdk", env: { [ENV_KEYS["claude-agent-sdk"]]: "sk-ant" }, kind: "api" },
      { id: "claude-code-cli", env: { [ENV_KEYS["claude-code-cli"]]: "sk-ant" }, kind: "cli" },
      { id: "codex-cli", env: {}, kind: "cli" },
    ] as const

    for (const ship of ships) {
      const named = config({ brain: { id: ship.id, model: "a/b" } })
      // The decision model is passed in, so a missing Jev key cannot be
      // mistaken for a brain that would not build.
      const { brains } = providersFromConfig(
        named,
        { decisionModel: scriptedDecisionModel([]) },
        ship.env,
      )

      expect(brains.map((brain) => brain.id)).toEqual([ship.id])
      // BRAIN-4 rests on this: a CLI brain has to say that it is one.
      expect(brains[0]?.kind).toBe(ship.kind)
    }
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
    // Asserts which provider complained, not merely that something did.
    // A probe caught this passing for the wrong reason: the decision
    // model in this config reads the OpenRouter key too, so it raised the
    // problem first and the test went green even with the brain's own
    // check removed.
    let problems: string[] = []
    try {
      providersFromConfig(config(), {}, { [ENV_KEYS.openrouter]: "" })
    } catch (error) {
      problems = (error as ProviderError).problems
    }

    expect(problems.join("\n")).toContain("brain openrouter")
  })

  test("CFG-2: a key that is only whitespace counts as missing too", () => {
    // New with the cleanup that put every key read behind `envValue`. A
    // key pasted with a stray space or newline used to pass this check
    // and then come back from the vendor as a 401, which says nothing
    // about what is actually wrong. It is refused here instead, with the
    // message that names the variable to set.
    for (const blank of [" ", "   ", "\n", " \t "]) {
      let problems: string[] = []
      try {
        providersFromConfig(config(), {}, { [ENV_KEYS.openrouter]: blank })
      } catch (error) {
        problems = (error as ProviderError).problems
      }
      expect(problems.join("\n")).toContain(ENV_KEYS.openrouter)
    }
  })

  test("CFG-2: a real key pasted with a newline still works, trimmed", () => {
    // The other half, and the reason trimming rather than refusing: a key
    // copied out of a terminal usually arrives with a newline on it, and
    // that is a real key, not a blank one.
    expect(() =>
      providersFromConfig(config(), {}, { [ENV_KEYS.openrouter]: " sk-real-key\n" }),
    ).not.toThrow()
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

describe("DEP-3: the database the agent runs against", () => {
  // `supabaseFromEnv` had no tests of its own, which the cleanup turned up:
  // its two variables moved behind `envValue` and nothing would have said
  // so if that had gone wrong. The checks it makes are the same ones the
  // brains make, and a database with a blank URL is the one that matters
  // most, because every table in the core is behind it.
  test("CFG-2: a missing URL or key is a clear error naming the variable", () => {
    let problems: string[] = []
    try {
      supabaseFromEnv({})
    } catch (error) {
      problems = (error as ProviderError).problems
    }

    expect(problems.join("\n")).toContain(DB_ENV_KEYS.url)
    expect(problems.join("\n")).toContain(DB_ENV_KEYS.serviceRoleKey)
    // Both in one pass, not the first one only.
    expect(problems).toHaveLength(2)
  })

  test("CFG-2: a blank URL counts as missing, not as a URL", () => {
    for (const blank of ["", " ", "\n"]) {
      expect(() =>
        supabaseFromEnv({ [DB_ENV_KEYS.url]: blank, [DB_ENV_KEYS.serviceRoleKey]: "k" }),
      ).toThrow(ProviderError)
    }
  })

  test("CFG-2: a blank service role key counts as missing", () => {
    for (const blank of ["", " ", "\n"]) {
      expect(() =>
        supabaseFromEnv({
          [DB_ENV_KEYS.url]: "http://127.0.0.1:54321",
          [DB_ENV_KEYS.serviceRoleKey]: blank,
        }),
      ).toThrow(ProviderError)
    }
  })

  test("CFG-2: both set, pasted with newlines, builds a client", () => {
    expect(() =>
      supabaseFromEnv({
        [DB_ENV_KEYS.url]: " http://127.0.0.1:54321\n",
        [DB_ENV_KEYS.serviceRoleKey]: " service-role-key\n",
      }),
    ).not.toThrow()
  })
})

describe("DEP-2: the transcriber built from config", () => {
  test("MEDIA-1: an agent with no transcriber in config gets none, and no problem", () => {
    // The one optional provider. MEDIA-1 says what happens without it,
    // so its absence is a supported configuration and not a mistake.
    const built = providersFromConfig(config(), {}, { [ENV_KEYS.openrouter]: "sk-test" })

    expect(built.transcriber).toBeUndefined()
  })

  test("DEP-2: openrouter is built on the key the brain already uses", () => {
    const built = providersFromConfig(
      config({ transcriber: { id: "openrouter" } }),
      {},
      { [ENV_KEYS.openrouter]: "sk-test" },
    )

    expect(built.transcriber?.id).toBe("openrouter")
  })

  test("DEP-2: sarvam reads its own key", () => {
    const built = providersFromConfig(
      config({ transcriber: { id: "sarvam" } }),
      {},
      { [ENV_KEYS.openrouter]: "sk-test", [ENV_KEYS.sarvam]: "sarvam-key" },
    )

    expect(built.transcriber?.id).toBe("sarvam")
  })

  test("CFG-2: a missing transcriber key is reported, naming the variable", () => {
    let problems: string[] = []
    try {
      providersFromConfig(
        config({ transcriber: { id: "sarvam" } }),
        {},
        { [ENV_KEYS.openrouter]: "sk-test" },
      )
    } catch (error) {
      problems = (error as ProviderError).problems
    }

    expect(problems.join("\n")).toContain("transcriber sarvam")
    expect(problems.join("\n")).toContain(ENV_KEYS.sarvam)
  })

  test("DEP-3: a transcriber passed in wins, and no key is read for it", () => {
    const fake = { id: "fake", transcribe: async () => ({ text: "hello" }) }
    const built = providersFromConfig(
      config({ transcriber: { id: "sarvam" } }),
      { transcriber: fake },
      { [ENV_KEYS.openrouter]: "sk-test" },
    )

    expect(built.transcriber).toBe(fake)
  })

  test("DEP-2: openai is not a transcriber, because every OpenAI model is on OpenRouter", () => {
    // The decision in the log: a second adapter to the same models would
    // be a second code path and a second key for nothing.
    expect(() => config({ transcriber: { id: "openai" } })).toThrow()
  })
})

describe("KNOW-4: the retriever built from config", () => {
  test("KNOW-4: local is built, with keyword ranking and no embedder", () => {
    const built = providersFromConfig(config(), {}, { [ENV_KEYS.openrouter]: "sk-test" })

    expect(built.retriever.id).toBe("local")
  })

  test("KNOW-4: an embedder is built only when config names one", () => {
    // `embedder: null` is the ordinary case, not a missing setting:
    // KNOW-4 says keyword ranking alone unless one is configured.
    let problems: string[] = []
    try {
      providersFromConfig(
        config({ retriever: { id: "local", embedder: "openai" } }),
        {},
        { [ENV_KEYS.openrouter]: "sk-test" },
      )
    } catch (error) {
      problems = (error as ProviderError).problems
    }

    expect(problems.join("\n")).toContain("openai embedder")
    expect(problems.join("\n")).toContain(ENV_KEYS["openai-agents"])
  })

  test("KNOW-4: with the key, the embedded retriever builds", () => {
    const built = providersFromConfig(
      config({ retriever: { id: "local", embedder: "openai" } }),
      {},
      { [ENV_KEYS.openrouter]: "sk-test", [ENV_KEYS["openai-agents"]]: "sk-openai" },
    )

    expect(built.retriever.id).toBe("local")
  })

  test("DEP-3: a retriever passed in wins, and no key is read for it", () => {
    const fake = { id: "fake", index: async () => {}, search: async () => [] }
    const built = providersFromConfig(
      config({ retriever: { id: "pgvector" } }),
      { retriever: fake },
      { [ENV_KEYS.openrouter]: "sk-test" },
    )

    expect(built.retriever).toBe(fake)
  })

  test("T8.3: pgvector is named plainly rather than quietly becoming local", () => {
    // An agent searching something other than what its config says would
    // be worse than a refusal to start.
    let problems: string[] = []
    try {
      providersFromConfig(
        config({ retriever: { id: "pgvector" } }),
        {},
        { [ENV_KEYS.openrouter]: "sk-test" },
      )
    } catch (error) {
      problems = (error as ProviderError).problems
    }

    expect(problems.join("\n")).toContain("pgvector is not built yet")
  })
})
