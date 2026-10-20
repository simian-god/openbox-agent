// LEARN-2: the version a turn ran under.
//
// The hash has to move when anything the agent's behaviour depends on
// moves, and stay still when nothing did. Both halves matter: a hash that
// changes on every start makes a review meaningless, and one that never
// changes hides the change that broke something.
import { test, expect, describe } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { versionHash, versionFingerprint, stableStringify } from "../../src/runtime/version.ts"
import { CORE_VERSION } from "../../src/version.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool, type Tool } from "../../src/tools/index.ts"

const PROMPT = "You are the host at a restaurant."

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: [["11:00", "23:00"]] },
    brain: { id: "openrouter", model: "test/model" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages.",
    retentionDays: 365,
    ...over,
  })
}

function tool(over: Record<string, unknown> = {}): Tool {
  return defineTool({
    name: "check_availability",
    description: "Checks whether a table is free.",
    input: z.object({ date: z.string() }),
    risk: "read",
    roles: ["end_user"],
    conditions: {
      callWhen: ["The person asks whether a table is free"],
      dontCallWhen: ["The person is not asking about a booking"],
    },
    examples: { should: ["Any space on Friday?"], shouldNot: ["Hello"] },
    handler: async () => ({ free: true }),
    ...over,
  } as never)
}

const base = () => ({ prompt: PROMPT, tools: [tool()], config: config() })

describe("LEARN-2: what the hash covers", () => {
  test("LEARN-2: the same agent hashes the same way twice", () => {
    expect(versionHash(base())).toBe(versionHash(base()))
  })

  test("LEARN-2: it is a sha256 hex digest", () => {
    expect(versionHash(base())).toMatch(/^[0-9a-f]{64}$/)
  })

  test("LEARN-2: a changed prompt is a new version", () => {
    expect(versionHash({ ...base(), prompt: "You are the host at a dentist." })).not.toBe(
      versionHash(base()),
    )
  })

  test("LEARN-2: a changed tool name is a new version", () => {
    expect(versionHash({ ...base(), tools: [tool({ name: "check_tables" })] })).not.toBe(
      versionHash(base()),
    )
  })

  test("LEARN-2: a changed tool description is a new version", () => {
    expect(
      versionHash({ ...base(), tools: [tool({ description: "Checks the waiting list." })] }),
    ).not.toBe(versionHash(base()))
  })

  test("LEARN-2: changed conditions are a new version", () => {
    const changed = tool({
      conditions: {
        callWhen: ["The person asks about a table"],
        dontCallWhen: ["The person is not asking about a booking"],
      },
    })
    expect(versionHash({ ...base(), tools: [changed] })).not.toBe(versionHash(base()))
  })

  test("LEARN-2: a changed input schema is a new version", () => {
    const changed = tool({ input: z.object({ date: z.string(), size: z.number() }) })
    expect(versionHash({ ...base(), tools: [changed] })).not.toBe(versionHash(base()))
  })

  test("LEARN-2: a changed risk is a new version", () => {
    expect(versionHash({ ...base(), tools: [tool({ risk: "write" })] })).not.toBe(
      versionHash(base()),
    )
  })

  test("LEARN-2: moving a tool to another role is a new version", () => {
    // Who may call a tool decides what the agent will do for a given
    // person, so it has to be part of the version (see the decisions log).
    expect(versionHash({ ...base(), tools: [tool({ roles: ["operator"] })] })).not.toBe(
      versionHash(base()),
    )
  })

  test("LEARN-2: a changed config is a new version", () => {
    expect(versionHash({ ...base(), config: config({ maxSteps: 4 }) })).not.toBe(
      versionHash(base()),
    )
  })

  test("LEARN-2: a new core version is a new version", () => {
    expect(versionHash({ ...base(), coreVersion: "9.9.9" })).not.toBe(versionHash(base()))
  })

  test("LEARN-2: adding a tool is a new version", () => {
    const second = tool({ name: "read_menu" })
    expect(versionHash({ ...base(), tools: [tool(), second] })).not.toBe(versionHash(base()))
  })
})

describe("LEARN-2: what the hash ignores", () => {
  test("LEARN-2: registering the same tools in another order is the same version", () => {
    const a = tool()
    const b = tool({ name: "read_menu" })
    expect(versionHash({ ...base(), tools: [a, b] })).toBe(
      versionHash({ ...base(), tools: [b, a] }),
    )
  })

  test("LEARN-2: writing the config fields in another order is the same version", () => {
    const ordered = defineConfig({
      retentionDays: 365,
      notice: "We store your messages.",
      limits: { dailySpendUsd: 5 },
      retriever: { id: "local" },
      decisionModel: { id: "jev" },
      brain: { id: "openrouter", model: "test/model" },
      hours: { mon: [["11:00", "23:00"]] },
      timezone: "Asia/Kolkata",
      mode: "development",
      name: "restaurant",
    })
    expect(versionHash({ ...base(), config: ordered })).toBe(versionHash(base()))
  })

  test("CFG-2: a credential in config cannot change the hash", () => {
    // CFG-2 keeps credentials out of config in the first place. This is the
    // second line of defence: a key that got there anyway is left out of
    // what is hashed, so the hash is still the hash of the agent.
    const withKey = { ...config(), apiKey: "sk-live-1" } as unknown as OpenboxConfig
    const withAnother = { ...config(), apiKey: "sk-live-2" } as unknown as OpenboxConfig

    expect(versionHash({ ...base(), config: withKey })).toBe(
      versionHash({ ...base(), config: withAnother }),
    )
  })

  test("LEARN-2: the examples a tool carries are not part of the version", () => {
    // LEARN-2 lists name, description, conditions, schema and risk. Examples
    // feed routing and `openbox tune`, not the agent's own behaviour, so a
    // reworded example does not start a new version.
    const changed = tool({ examples: { should: ["Got a table tonight?"], shouldNot: ["Hello"] } })
    expect(versionHash({ ...base(), tools: [changed] })).toBe(versionHash(base()))
  })

  test("LEARN-2: writing a tool's roles in another order is the same version", () => {
    // A role is either allowed or not, so the order they are listed in
    // says nothing about the agent.
    const changed = tool({ roles: ["operator", "end_user"] })
    const same = tool({ roles: ["end_user", "operator"] })
    expect(versionHash({ ...base(), tools: [changed] })).toBe(
      versionHash({ ...base(), tools: [same] }),
    )
  })
})

describe("LEARN-2: the fingerprint", () => {
  test("LEARN-2: it carries the prompt, the tools, the config and the core version", () => {
    const print = versionFingerprint(base())

    expect(print.core).toBe(CORE_VERSION)
    expect(print.prompt).toBe(PROMPT)
    expect(print.tools).toEqual([
      {
        name: "check_availability",
        description: "Checks whether a table is free.",
        conditions: {
          callWhen: ["The person asks whether a table is free"],
          dontCallWhen: ["The person is not asking about a booking"],
        },
        inputSchema: tool().inputSchema,
        risk: "read",
        roles: ["end_user"],
      },
    ])
    expect((print.config as { name: string }).name).toBe("restaurant")
  })

  test("LEARN-2: a credential shaped config field is left out of the fingerprint", () => {
    const withKey = { ...config(), apiKey: "sk-live-1" } as unknown as OpenboxConfig
    const print = versionFingerprint({ ...base(), config: withKey })

    expect(JSON.stringify(print)).not.toContain("sk-live-1")
  })
})

describe("stableStringify", () => {
  test("it sorts object keys, so field order cannot change a hash", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  test("it sorts nested keys too", () => {
    expect(stableStringify({ x: { d: 1, c: 2 } })).toBe('{"x":{"c":2,"d":1}}')
  })

  test("it keeps array order, which carries meaning", () => {
    expect(stableStringify([2, 1])).toBe("[2,1]")
  })

  test("undefined is dropped, so an absent field and a missing one match", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}')
  })
})

test("CORE_VERSION matches the version in package.json", () => {
  // The hash carries the core version, so a drift here would silently
  // stop a core upgrade from showing up as a new version.
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
  ) as { version: string }
  expect(CORE_VERSION).toBe(pkg.version)
})
