// SKILL-7 and LEARN-7: the `openbox tune` command itself.
//
// Two things about it are decisions rather than mechanics, and both are
// here. It asks for no brain key and no database, because tuning a dial on
// the decision model has nothing to do with either and a command that
// demands keys it will not use is a command nobody runs. And it changes
// `agent.config.ts` only when asked, because LEARN-7 says nothing changes
// the agent without the builder's approval.
import { test, expect, describe, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { runTune } from "../../src/cli/tune.ts"
import { fakeIo } from "../support/chat.ts"
import { scriptedDecisionModel, choice } from "../../src/testing/scripted-decision.ts"
import { NO_TOOL, ROUTING_QUESTION } from "../../src/runtime/routing.ts"
import type { DecisionModel, Question } from "../../src/providers/decision/types.ts"

const CORE = pathToFileURL(join(import.meta.dir, "..", "..", "src", "index.ts")).href
const ZOD = import.meta.resolve("zod")

const config = (over = "") => `
export default {
  name: "restaurant",
  mode: "development",
  timezone: "Asia/Kolkata",
  hours: { mon: [["11:00", "23:00"]] },
  brain: { id: "openrouter", model: "test/model" },
  decisionModel: { id: "jev", routeThreshold: 0.6 },
  retriever: { id: "local" },
  limits: { dailySpendUsd: 5 },
  notice: "We store your messages.",
  retentionDays: 365,${over}
}
`

const TOOL = (name: string) => `
import { defineTool } from ${JSON.stringify(CORE)}
import { z } from ${JSON.stringify(ZOD)}

export default defineTool({
  name: ${JSON.stringify(name)},
  description: "Does ${name}.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: {
    callWhen: ["the person asks about ${name}"],
    dontCallWhen: ["the person is not asking about ${name}"],
  },
  examples: { should: ["about ${name}"], shouldNot: ["hello"] },
  handler: async () => ({ ok: true }),
})
`

const SIX = ["book", "cancel", "menu", "hours", "directions", "parking"]

const made: string[] = []

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "openbox-tune-"))
  made.push(dir)
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, body, "utf8")
  }
  return dir
}

/** Six tools, which is one more than routing's default minimum. */
function sixToolProject(over: Record<string, string> = {}): string {
  const files: Record<string, string> = {
    "agent.config.ts": config(),
    "prompt.md": "# Identity and goal\nYou are the host.",
  }
  for (const name of SIX) files[`tools/${name}.ts`] = TOOL(name)
  return project({ ...files, ...over })
}

/** Answers every question with the same confident pick. */
const alwaysPicks = (name: string) =>
  scriptedDecisionModel([{ [ROUTING_QUESTION]: choice(name, { [name]: 0.95, no_tool: 0.05 }) }])

/**
 * A decision model that is actually good at this.
 *
 * The tools here are named `book`, `cancel` and so on, and their example
 * messages say "about book". So picking the tool whose name is in the
 * message is right every time, which is what a well tuned agent looks
 * like, and the only way to test what the report says about one.
 */
function rightEveryTime(): DecisionModel & { asked: number } {
  const model = {
    id: "scripted",
    asked: 0,
    async ask(state: unknown, questions: Record<string, Question>) {
      model.asked++
      const batch = (state as { batch: string[] }).batch.join(" ")
      const options = Object.keys(
        (questions[ROUTING_QUESTION] as { options: Record<string, unknown> }).options,
      )
      const match = options.find((name) => name !== NO_TOOL && batch.includes(name)) ?? NO_TOOL
      return {
        answers: {
          [ROUTING_QUESTION]: {
            type: "choice" as const,
            choice: match,
            probabilities: { [match]: 0.95, [NO_TOOL]: 0.05 },
            confidence: 0.95,
          },
        },
        usage: { inputTokens: 100, costUsd: 0.00002 },
      }
    },
  }
  return model
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("SKILL-7: openbox tune", () => {
  test("SKILL-7: it reports with no database and no brain key", async () => {
    // The config names an OpenRouter brain and no key is set anywhere.
    const io = fakeIo([])
    const code = await runTune({
      dir: sixToolProject(),
      io,
      env: {},
      decisionModel: alwaysPicks("book"),
    })

    expect(code).toBe(0)
    expect(io.text()).toContain("openbox tune - restaurant")
    expect(io.text()).toContain("threshold")
  })

  test("SKILL-7: it says what it is about to spend before it spends it", async () => {
    const io = fakeIo([])
    await runTune({ dir: sixToolProject(), io, env: {}, decisionModel: alwaysPicks("book") })

    expect(io.text()).toContain("labeled examples")
    expect(io.text()).toContain("costs money")
  })

  test("LEARN-5: a tool's own examples are enough, with no routing.jsonl at all", async () => {
    const model = alwaysPicks("book")
    const io = fakeIo([])
    await runTune({ dir: sixToolProject(), io, env: {}, decisionModel: model })

    // Six tools, one `should` and one `shouldNot` each, so twelve labels.
    // Every `shouldNot` here is the word "hello", and those twelve labels
    // are only seven questions: the same conversation asked of the same
    // options is the same question, and it is paid for once.
    expect(io.text()).toContain("12 labeled examples")
    expect(model.calls).toHaveLength(7)
    expect(io.text()).toContain("shared an answer")
  })

  test("LEARN-5: every tool's shouldNot is still checked, even sharing a message", async () => {
    // Six tools all warn against "hello". That is six statements, not one,
    // and folding them into one would quietly stop checking five.
    const model = alwaysPicks("book")
    const io = fakeIo([])
    await runTune({ dir: sixToolProject(), io, env: {}, decisionModel: model })

    // The model answers "book" to everything, so exactly one of the six
    // warnings is broken, and the report has to see it.
    expect(io.text()).toContain("warned against   1 / 6")
  })

  test("LEARN-5: routing.jsonl joins the tools' examples", async () => {
    const model = alwaysPicks("book")
    const io = fakeIo([])
    await runTune({
      dir: sixToolProject({
        "examples/routing.jsonl": [
          '{"text": "a table for four tonight", "tool": "book"}',
          '{"text": "where do i park?", "tool": "parking"}',
        ].join("\n"),
      }),
      io,
      env: {},
      decisionModel: model,
    })

    expect(io.text()).toContain("14 labeled examples")
    expect(model.calls).toHaveLength(9)
  })

  test("LEARN-5: a broken routing.jsonl stops the run and names every problem", async () => {
    // Nothing is asked and nothing is spent, because a measurement on half
    // a labeled set is worse than no measurement.
    const model = alwaysPicks("book")
    const io = fakeIo([])
    const code = await runTune({
      dir: sixToolProject({
        "examples/routing.jsonl": ['{"text": "a", "tool": "boook"}', "not json"].join("\n"),
      }),
      io,
      env: {},
      decisionModel: model,
    })

    expect(code).toBe(1)
    expect(model.calls).toHaveLength(0)
    expect(io.text()).toContain("boook")
    expect(io.text()).toContain("not valid JSON")
  })

  test("ROUTE-1: an agent routing never runs for is told so, and nothing is asked", async () => {
    // Five tools against the default routingMinTools of 5. The threshold
    // is never read, so measuring it would be paying for an answer to a
    // question this agent does not ask.
    const files: Record<string, string> = {
      "agent.config.ts": config(),
      "prompt.md": "# Identity and goal\nYou are the host.",
    }
    for (const name of SIX.slice(0, 5)) files[`tools/${name}.ts`] = TOOL(name)

    const model = alwaysPicks("book")
    const io = fakeIo([])
    const code = await runTune({ dir: project(files), io, env: {}, decisionModel: model })

    expect(code).toBe(0)
    expect(model.calls).toHaveLength(0)
    expect(io.text()).toContain("routing never runs")
    expect(io.text()).toContain("Nothing to tune")
  })

  test("SKILL-7: a folder with no agent in it says what is missing", async () => {
    const io = fakeIo([])
    const code = await runTune({ dir: project({ "readme.md": "nothing here" }), io, env: {} })

    expect(code).toBe(1)
    expect(io.text()).toContain("agent.config.ts")
  })

  test("SKILL-7: a missing decision model key is named, not a stack trace", async () => {
    const io = fakeIo([])
    const code = await runTune({ dir: sixToolProject(), io, env: {} })

    expect(code).toBe(1)
    expect(io.text()).toContain("OPENROUTER_API_KEY")
    expect(io.text()).toContain("openbox tune again")
  })
})

describe("LEARN-7: nothing changes the agent without approval", () => {
  test("LEARN-7: without --write the config file is untouched", async () => {
    const dir = sixToolProject()
    const before = readFileSync(join(dir, "agent.config.ts"), "utf8")

    const io = fakeIo([])
    await runTune({ dir, io, env: {}, decisionModel: rightEveryTime(), tolerance: 0 })

    expect(readFileSync(join(dir, "agent.config.ts"), "utf8")).toBe(before)
    // And it says how to apply it, so the next step is obvious.
    expect(io.text()).toContain("--write")
  })

  test("LEARN-7: with --write the one number changes and nothing else does", async () => {
    const dir = sixToolProject()
    const io = fakeIo([])
    const code = await runTune({
      dir,
      io,
      env: {},
      decisionModel: rightEveryTime(),
      tolerance: 0,
      write: true,
    })

    expect(code).toBe(0)
    const after = readFileSync(join(dir, "agent.config.ts"), "utf8")
    // A model that is right every time can narrow at any threshold, so the
    // recommendation is the lowest one there is.
    expect(after).toContain("routeThreshold: 0.00")
    expect(after).not.toContain("routeThreshold: 0.6,")
    expect(after).toContain(`name: "restaurant"`)
    expect(io.text()).toContain("Set routeThreshold to")
  })

  test("LEARN-7: with --write and nothing to recommend, the file is still untouched", async () => {
    const dir = sixToolProject()
    const before = readFileSync(join(dir, "agent.config.ts"), "utf8")
    const io = fakeIo([])

    // Certain and wrong, at every threshold, so no threshold is safe.
    await runTune({
      dir,
      io,
      env: {},
      decisionModel: scriptedDecisionModel([{ [ROUTING_QUESTION]: choice("menu") }]),
      tolerance: 0,
      write: true,
    })

    expect(readFileSync(join(dir, "agent.config.ts"), "utf8")).toBe(before)
    expect(io.text()).toContain("No threshold keeps misses")
  })
})
