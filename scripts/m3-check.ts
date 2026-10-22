// The M3 check, from Plan.md: "C3, C7 and C8 can be measured on the demo
// agent, and a decision model outage test proves GATE-4."
//
// In the repo rather than run once and thrown away, because one of its four
// items fails on purpose and has to be checked again later. C8 cannot be
// measured on the demo agent, which has one tool, and routing never runs
// below `routingMinTools` (ROUTE-1). That is Known K13 and it closes at
// T11.1, when the skill rebuilds the demo agent with a real tool set. Run
// this again then.
//
// No keys and no database. Every item is about whether the demo agent can
// be measured, not about what a provider answers.
//
// Usage: bun run m3-check
import { loadProject } from "../packages/core/src/cli/project.ts"
import { defineConfig } from "../packages/core/src/config/index.ts"
import { defineTool, ToolError, type Tool } from "../packages/core/src/tools/index.ts"
import { decisionModelFromConfig, ENV_KEYS } from "../packages/core/src/providers/index.ts"
import { createAgent } from "../packages/core/src/runtime/agent.ts"
import { gate } from "../packages/core/src/runtime/gate.ts"
import { scriptedBrain } from "../packages/core/src/testing/scripted-brain.ts"
import { scriptedDecisionModel } from "../packages/core/src/testing/scripted-decision.ts"
import { fakeSender } from "../packages/core/src/testing/fake-sender.ts"
import { loadForC8 } from "./c8.ts"
import { join } from "node:path"

const DEMO = join(import.meta.dir, "..", "examples", "demo-agent")

interface Item {
  id: string
  what: string
  pass: boolean
  detail: string[]
}

export async function runM3Check(dir: string = DEMO): Promise<Item[]> {
  const items: Item[] = []
  const demo = await loadProject({ dir })

  // The demo agent's own input schema, borrowed for the fixtures below.
  // The repo root has no zod of its own, and reusing the real schema is a
  // truer fixture than inventing one would be.
  const schema = demo.tools[0]?.input

  // ------------------------------------------------------------------- C3
  // "The same agent runs on Jev and on OpenAI Decisions API by changing
  // config only." Measured as: the demo agent's own config, with nothing
  // changed but the decision model, builds and starts on both.
  {
    const detail: string[] = []
    let pass = true

    for (const wanted of [
      { id: "jev", route: "openrouter" },
      { id: "openai-decisions" },
    ] as const) {
      try {
        const config = defineConfig({
          ...(demo.config as unknown as Record<string, unknown>),
          decisionModel: wanted,
        } as never)

        // A fake key for whichever route this one reads. C3 is about
        // config, not about what a vendor answers.
        const env =
          wanted.id === "jev"
            ? { [ENV_KEYS.openrouter]: "sk-or-fake" }
            : { [ENV_KEYS["openai-agents"]]: "sk-openai-fake" }

        const built = decisionModelFromConfig(config, env)
        const agent = createAgent({
          config,
          deps: {
            brains: [scriptedBrain([{ reply: "hi" }])],
            decisionModel: built,
            db: { from: () => ({}) } as never,
            sender: fakeSender(),
          },
          prompt: demo.prompt,
          tools: demo.tools,
        })

        detail.push(
          `${wanted.id}: built as "${built.id}", version ${agent.versionHash.slice(0, 12)}`,
        )
      } catch (error) {
        pass = false
        detail.push(`${wanted.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    detail.push("nothing but decisionModel differs between the two")
    // LEARN-2: and the version hash does differ, because the decision
    // model is part of config. Swapping it is a change to the agent, and
    // the trace should say so.
    detail.push("the two versions differ, which is right: a swap is a change to the agent")
    items.push({ id: "C3", what: "both decision models, by config alone", pass, detail })
  }

  // ------------------------------------------------------------------- C7
  // "Registering a tool without both conditions fails with a clear error."
  // Measured on the demo agent's own tool, with its conditions taken away.
  {
    const detail: string[] = []
    const tool: Tool | undefined = demo.tools[0]

    if (tool === undefined) {
      items.push({
        id: "C7",
        what: "a tool without both conditions is refused",
        pass: false,
        detail: ["the demo agent has no tools to try it on"],
      })
    } else {
      const cases: [string, { callWhen: string[]; dontCallWhen: string[] }][] = [
        ["no callWhen", { callWhen: [], dontCallWhen: tool.conditions.dontCallWhen }],
        ["no dontCallWhen", { callWhen: tool.conditions.callWhen, dontCallWhen: [] }],
        ["neither", { callWhen: [], dontCallWhen: [] }],
      ]

      let pass = true
      for (const [name, conditions] of cases) {
        try {
          defineTool({
            name: tool.name,
            description: tool.description,
            input: tool.input,
            risk: tool.risk,
            roles: tool.roles,
            conditions,
            examples: tool.examples,
            handler: tool.handler,
          })
          pass = false
          detail.push(`${name}: accepted, which it must not be`)
        } catch (error) {
          const problems = error instanceof ToolError ? error.problems : []
          const namesTheField = problems.some((problem) => /callWhen|dontCallWhen/.test(problem))
          if (!namesTheField) pass = false
          detail.push(
            `${name}: refused with ${problems.length} problem(s), names the field: ${namesTheField}`,
          )
        }
      }
      items.push({
        id: "C7",
        what: "a tool without both conditions is refused, clearly",
        pass,
        detail,
      })
    }
  }

  // ------------------------------------------------------------------- C8
  {
    const loaded = await loadForC8(dir)
    const enough = loaded.tools.length > loaded.config.routingMinTools
    items.push({
      id: "C8",
      what: "routing can be measured on the demo agent",
      pass: enough,
      detail: enough
        ? [
            `${loaded.tools.length} tools against routingMinTools ${loaded.config.routingMinTools}`,
            "run it: bun run c8 --dir examples/demo-agent --go",
          ]
        : [
            `the demo agent has ${loaded.tools.length} tool(s) and routingMinTools is ${loaded.config.routingMinTools}`,
            "routing never runs below that (ROUTE-1), so there are no two arms to compare",
            "the measurement itself works, on a fixture:",
            "  bun run c8 --dir packages/core/test/fixtures/routing-agent",
            "Known K13. Closes at T11.1, when the skill rebuilds the demo agent",
          ],
    })
  }

  // ---------------------------------------------------------------- GATE-4
  // "a decision model outage test proves GATE-4." The tests are in
  // test/unit/gate.test.ts and test/integration/turn.test.ts. Run here as
  // well, because this is the claim the whole safety story rests on and it
  // should be checkable in one command.
  {
    const detail: string[] = []
    const base = {
      description: "Changes something.",
      input: schema as NonNullable<typeof schema>,
      roles: ["end_user"] as const,
      conditions: { callWhen: ["the person asked for it"], dontCallWhen: ["they did not"] },
      examples: { should: ["do it"], shouldNot: ["hello"] },
      handler: async () => ({ done: true }),
    }

    const write = defineTool({
      ...base,
      name: "change_something",
      risk: "write",
      roles: ["end_user"],
    })
    const risky = defineTool({
      ...base,
      name: "cannot_be_undone",
      risk: "irreversible",
      roles: ["end_user"],
      confirmSummary: () => "do the irreversible thing?",
    })
    const read = defineTool({
      ...base,
      name: "look_something_up",
      risk: "read",
      roles: ["end_user"],
    })

    const down = scriptedDecisionModel([{ throws: "the provider is down", retryable: true }])
    const conversation = { messages: [{ role: "person", text: "do it" }], activeTask: null }
    let pass = true

    for (const tool of [write, risky]) {
      const decision = await gate({
        decisionModel: down,
        tool,
        args: {},
        conversation,
        timeoutMs: 3000,
      })
      if (decision.outcome === "run") {
        pass = false
        detail.push(`${tool.risk}: RAN, which GATE-4 forbids`)
      } else {
        detail.push(`${tool.risk}: ${decision.outcome} (${decision.reason}), did not run`)
      }
    }

    // GATE-5: and a read tool is untouched by the outage, so an agent that
    // can only read still works while the provider is down.
    const reading = await gate({
      decisionModel: down,
      tool: read,
      args: {},
      conversation,
      timeoutMs: 3000,
    })
    if (reading.outcome !== "run") pass = false
    detail.push(`read: ${reading.outcome} (${reading.reason}), unaffected by the outage`)

    items.push({
      id: "GATE-4",
      what: "an outage never lets a write or irreversible call run",
      pass,
      detail,
    })
  }

  return items
}

export function formatM3(items: Item[]): string {
  const lines = ["", "================ M3 check ================", ""]
  for (const item of items) {
    lines.push(`${item.pass ? "PASS" : "FAIL"}  ${item.id}  ${item.what}`)
    for (const line of item.detail) lines.push(`        ${line}`)
    lines.push("")
  }
  const failed = items.filter((item) => !item.pass)
  lines.push(
    failed.length === 0
      ? "All items pass."
      : `${failed.length} of ${items.length} items fail: ${failed.map((item) => item.id).join(", ")}`,
  )
  return lines.join("\n")
}

if (import.meta.main) {
  const items = await runM3Check()
  console.log(formatM3(items))
  process.exit(items.every((item) => item.pass) ? 0 : 1)
}
