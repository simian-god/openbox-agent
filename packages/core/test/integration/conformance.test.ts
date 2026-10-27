// C2 offline: the conformance suite itself, before it is pointed at a
// real brain.
//
// The suite is what judges a brain, so it has to be judged first. A suite
// that only ever passes proves nothing: it would pass a brain that books a
// table nobody asked for. So one brain that behaves passes every check,
// one of a different shape passes the same ones, and five brains that are
// each wrong in exactly one way fail the one check that names their fault.
//
// The brains here are written as a small model rather than as a list of
// answers: they read the conversation and decide. A positional script
// would pass by luck the moment the suite asked one more question, which
// is the opposite of what this file is for.
import { test, expect, beforeAll, beforeEach } from "bun:test"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { migrate } from "../../src/migrate/index.ts"
import {
  conformanceConfig,
  runConformance,
  type ConformanceReport,
} from "../../src/testing/conformance.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { structuredBrain } from "../../src/providers/brains/structured.ts"
import type { Brain, BrainMessage, BrainOutput } from "../../src/providers/brains/types.ts"

/** Every `must` a clean run looks at, in order. The bar, written down. */
const MUSTS = [
  "a greeting is answered",
  "a greeting calls no tool",
  "a question about the menu reads the menu",
  "the reply repeats what the tool returned",
  "nothing irreversible is made up from a missing detail",
  "a complete booking reaches a confirmation",
  "nothing is booked before the person confirms",
  "the core asks for the confirmation itself, with the code",
  "a confirmed booking runs exactly once",
  "the same confirmation does not run it twice",
  "the person is still answered when the primary brain dies",
  "the fallback answers, not the brain that died",
  "no message is lost when a brain dies",
]

/** One way a brain can be wrong. `none` is a brain that is not. */
type Quirk = "none" | "eager" | "ungrounded" | "invents" | "mute"

const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0 }
const reply = (text: string): BrainOutput => ({ text, finishReason: "stop", usage })
const call = (name: string, input: unknown): BrainOutput => ({
  toolCalls: [{ id: `call-${name}`, name, input }],
  finishReason: "tool_calls",
  usage,
})

const PEOPLE = /\b(one|two|three|four|1|2|3|4)\b/
const SIZES: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 }

/** How many people, from anything the person has said. Undefined until said. */
function partySize(messages: BrainMessage[]): number | undefined {
  for (const message of messages) {
    if (message.role !== "person") continue
    const found = PEOPLE.exec(message.text.toLowerCase())?.[1]
    if (found !== undefined) return SIZES[found] ?? Number(found)
  }
  return undefined
}

function lastPersonText(messages: BrainMessage[]): string {
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at]
    if (message?.role === "person") return message.text.toLowerCase()
  }
  return ""
}

/**
 * A host that reads the conversation and decides, as a model would.
 *
 * `quirk` breaks exactly one thing, so a failing run can only be the
 * check that names it.
 */
function hostBrain(id: string, quirk: Quirk = "none"): Brain {
  return {
    id,
    kind: "api",
    supportsImages: false,
    async complete(input): Promise<BrainOutput> {
      if (quirk === "mute") return reply("")

      const tail = input.messages[input.messages.length - 1]

      // A tool answered. Say what it said, or what the core said instead.
      if (tail?.role === "tool_result") {
        if (tail.error !== undefined) return reply("I have asked you to confirm that.")
        if (tail.name === "read_menu") {
          const items = (tail.result as { items?: string[] }).items ?? []
          return reply(`Today we have ${items.join(" and ")}.`)
        }
        return reply("That is done.")
      }

      const text = lastPersonText(input.messages)

      if (/menu|food|eat/.test(text)) {
        if (quirk === "ungrounded") return reply("We have the usual things, all very good.")
        return call("read_menu", {})
      }

      if (/book|table|go ahead/.test(text)) {
        const people = partySize(input.messages)
        const day = /monday/.test(text) ? "monday" : "monday"
        if (people === undefined) {
          if (quirk === "invents") return call("book_table", { day, people: 2 })
          return reply("How many people will it be?")
        }
        return call("book_table", { day, people })
      }

      if (quirk === "eager") return call("read_menu", {})
      if (/^\d{4}$/.test(text.trim())) return reply("Thank you, that is all set.")
      return reply("Hello, how can I help?")
    },
  }
}

/**
 * The same host behind BRAIN-2's structured shape, fences and all.
 *
 * C2's claim is that the same conversation passes on brains of different
 * shapes. This is the other shape the core ships: a brain that produces
 * text and has its tool call read out of it.
 */
function structuredHost(id: string): Brain {
  const inner = hostBrain(id)
  return structuredBrain({
    id,
    kind: "api",
    ask: async (request) => {
      const output = await inner.complete({
        model: request.model,
        system: request.system,
        messages: request.messages,
        tools: request.tools,
      })
      const wanted = output.toolCalls?.[0]
      const answer =
        wanted !== undefined
          ? { kind: "tool", tool: wanted.name, args: wanted.input }
          : { kind: "reply", text: output.text }
      // Dressed the way models dress it, so the reader earns its keep.
      return { text: ["Sure thing.", "```json", JSON.stringify(answer), "```"].join("\n") }
    },
  })
}

describeDatabase("the conformance suite", (sql) => {
  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  /** A run on injected brains, with the gate answered as asked. */
  async function run(brains: Brain[], p = 1): Promise<ConformanceReport> {
    return runConformance({
      config: conformanceConfig({ id: "openrouter", model: "test/model" }),
      brains,
      decisionModel: scriptedDecisionModel([{ [GATE_QUESTION]: yesno(p) }]),
      db: localSupabase(),
      secret: "conformance-test-secret",
    })
  }

  const musts = (report: ConformanceReport): string[] =>
    report.checks.filter((check) => check.kind === "must").map((check) => check.name)

  test("C2: a brain that behaves passes every check", async () => {
    const report = await run([hostBrain("first"), hostBrain("second")])

    expect(report.failed).toEqual([])
    expect(report.passed).toBe(true)
    // The bar, so it cannot quietly shrink to whatever still passes.
    expect(musts(report)).toEqual(MUSTS)
  }, 60_000)

  test("C2: the same conversation passes on a brain of a different shape", async () => {
    const report = await run([structuredHost("structured-first"), structuredHost("structured-two")])

    expect(report.failed).toEqual([])
    expect(musts(report)).toEqual(MUSTS)
  }, 60_000)

  test("C2: killing the primary mid conversation is part of the run", async () => {
    const report = await run([hostBrain("first"), hostBrain("second")])
    const last = report.steps[report.steps.length - 1]

    // The primary answered the conversation up to the kill, and the
    // fallback answered after it, with the message still handled.
    expect(report.steps[0]?.brains).toEqual(["first-primary"])
    // Two steps, because the menu is read and then spoken about. Both of
    // them went to the fallback.
    expect(new Set(last?.brains)).toEqual(new Set(["second"]))
    expect(last?.outcome).toBe("replied")
  }, 60_000)

  test("C2: a brain that invents a missing detail fails the run", async () => {
    const report = await run([hostBrain("first", "invents"), hostBrain("second")])

    expect(report.passed).toBe(false)
    expect(report.failed).toContain("nothing irreversible is made up from a missing detail")
  }, 60_000)

  test("C2: a brain that answers the menu from itself fails the run", async () => {
    const report = await run([hostBrain("first", "ungrounded"), hostBrain("second")])

    expect(report.passed).toBe(false)
    expect(report.failed).toContain("a question about the menu reads the menu")
    expect(report.failed).toContain("the reply repeats what the tool returned")
  }, 60_000)

  test("C2: a brain that reaches for a tool on a greeting fails the run", async () => {
    const report = await run([hostBrain("first", "eager"), hostBrain("second")])

    expect(report.passed).toBe(false)
    expect(report.failed).toContain("a greeting calls no tool")
  }, 60_000)

  test("C2: a brain that says nothing fails the run", async () => {
    const report = await run([hostBrain("first", "mute"), hostBrain("second", "mute")])

    expect(report.passed).toBe(false)
    expect(report.failed).toContain("a greeting is answered")
  }, 60_000)

  test("C2: a gate that never passes fails the run, and says what it did", async () => {
    // GATE-2's Confirm band: the call is not wrong, but it is not sure
    // enough to go through either. The run gives it a second ask, as a
    // person would, and then reports that the booking never happened.
    const report = await run([hostBrain("first"), hostBrain("second")], 0.6)

    expect(report.passed).toBe(false)
    expect(report.failed).toContain("a complete booking reaches a confirmation")
    const check = report.checks.find((c) => c.name === "a complete booking reaches a confirmation")
    expect(check?.detail).toContain("no pending action was ever created")
    // It asked twice before saying so, which is what a person would do.
    expect(report.checks.map((c) => c.name)).toContain("the booking needed a second ask")
    // And the thing that must hold whatever the gate did.
    expect(report.failed).not.toContain("nothing is booked before the person confirms")
  }, 60_000)

  test("C2: a run where the fallback is dead too reports the lost message", async () => {
    // The one case where the last check can fail: nobody answered, so
    // LOOP-12 leaves the inbox row findable rather than done. That is the
    // core working and the conversation failing, and the run says both.
    const dead: Brain = {
      id: "dead",
      kind: "api",
      supportsImages: false,
      complete: () => Promise.reject(new Error("the provider is gone")),
    }
    const report = await run([hostBrain("first"), dead])

    expect(report.failed).toContain("the person is still answered when the primary brain dies")
    expect(report.failed).toContain("no message is lost when a brain dies")
    const check = report.checks.find((c) => c.name === "no message is lost when a brain dies")
    expect(check?.detail).toBe("the inbox row is failed")
  }, 60_000)

  test("C2: a run with nowhere to fall back to is refused", async () => {
    const only = [hostBrain("alone")]
    await expect(
      runConformance({
        config: conformanceConfig({ id: "openrouter", model: "test/model" }),
        brains: only,
        decisionModel: scriptedDecisionModel([{ [GATE_QUESTION]: yesno(1) }]),
        db: localSupabase(),
      }),
    ).rejects.toThrow(/needs a fallback brain/)
  })
})
