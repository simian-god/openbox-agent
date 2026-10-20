// Loading an agent project off disk, in the layout PKG-3 lays out.
//
// `openbox chat` builds the agent from the files the project already has,
// so a project written by the skill needs no extra wiring to be chatted
// with. These tests write small projects in a temp folder and load them.
//
// PKG-3 itself is proven when the skill writes a project (M10), not here.
import { test, expect, describe, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { loadProject, ProjectError } from "../../src/cli/project.ts"

// Absolute, so a project written in a temp folder can still import both.
// A real project has the core and zod as dependencies and writes the plain
// names, which is what examples/demo-agent does.
const CORE = pathToFileURL(join(import.meta.dir, "..", "..", "src", "index.ts")).href
const ZOD = import.meta.resolve("zod")

const CONFIG = `
export default {
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
}
`

const TOOL = (name: string) => `
import { defineTool } from ${JSON.stringify(CORE)}
import { z } from ${JSON.stringify(ZOD)}

export default defineTool({
  name: ${JSON.stringify(name)},
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
})
`

const made: string[] = []

/** A project folder with whatever files the test asks for. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "openbox-project-"))
  made.push(dir)
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, body, "utf8")
  }
  return dir
}

const standard = (): Record<string, string> => ({
  "agent.config.ts": CONFIG,
  "prompt.md": "# Identity and goal\nYou are the host at a restaurant.",
  "tools/check_availability.ts": TOOL("check_availability"),
})

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("loading a project", () => {
  test("it reads the config, the prompt and every tool", async () => {
    const loaded = await loadProject({ dir: project(standard()) })

    expect(loaded.config.name).toBe("restaurant")
    expect(loaded.prompt).toContain("You are the host")
    expect(loaded.tools.map((tool) => tool.name)).toEqual(["check_availability"])
  })

  test("the config is filled in with its defaults, as defineConfig would", async () => {
    const loaded = await loadProject({ dir: project(standard()) })

    expect(loaded.config.maxSteps).toBe(8)
    expect(loaded.config.history).toBe(30)
  })

  test("a config already built by defineConfig loads unchanged", async () => {
    const files = standard()
    files["agent.config.ts"] = `
      import { defineConfig } from ${JSON.stringify(CORE)}
      export default defineConfig(${CONFIG.replace("export default ", "")})
    `
    const loaded = await loadProject({ dir: project(files) })
    expect(loaded.config.name).toBe("restaurant")
    expect(loaded.config.maxSteps).toBe(8)
  })

  test("several tool files all contribute", async () => {
    const files = standard()
    files["tools/read_menu.ts"] = TOOL("read_menu")
    const loaded = await loadProject({ dir: project(files) })

    expect(loaded.tools.map((tool) => tool.name).sort()).toEqual([
      "check_availability",
      "read_menu",
    ])
  })

  test("a tool exported by name, not as the default, is still found", async () => {
    const files = standard()
    files["tools/check_availability.ts"] = TOOL("check_availability").replace(
      "export default defineTool",
      "export const checkAvailability = defineTool",
    )
    const loaded = await loadProject({ dir: project(files) })

    expect(loaded.tools.map((tool) => tool.name)).toEqual(["check_availability"])
  })

  test("the same tool exported twice is only loaded once", async () => {
    const files = standard()
    files["tools/check_availability.ts"] = TOOL("check_availability").replace(
      "export default defineTool",
      "const theTool = defineTool",
    )
    files["tools/check_availability.ts"] +=
      "\nexport default theTool\nexport const again = theTool\n"

    const loaded = await loadProject({ dir: project(files) })
    expect(loaded.tools).toHaveLength(1)
  })

  test("it says where each file came from, so chat can show it", async () => {
    const dir = project(standard())
    const loaded = await loadProject({ dir })

    expect(loaded.files.config).toBe(join(dir, "agent.config.ts"))
    expect(loaded.files.prompt).toBe(join(dir, "prompt.md"))
    expect(loaded.files.tools).toEqual([join(dir, "tools", "check_availability.ts")])
  })

  test("an agent with no tools folder loads, since a tool is not required", async () => {
    const files = standard()
    delete files["tools/check_availability.ts"]
    const loaded = await loadProject({ dir: project(files) })

    expect(loaded.tools).toEqual([])
  })

  test("each path can be pointed somewhere else", async () => {
    const dir = project({
      "config/agent.ts": CONFIG,
      "docs/system.md": "You are the host.",
      "src/my-tools/one.ts": TOOL("check_availability"),
    })

    const loaded = await loadProject({
      dir,
      config: join(dir, "config", "agent.ts"),
      prompt: join(dir, "docs", "system.md"),
      tools: join(dir, "src", "my-tools"),
    })

    expect(loaded.config.name).toBe("restaurant")
    expect(loaded.prompt).toBe("You are the host.")
    expect(loaded.tools).toHaveLength(1)
  })
})

describe("a project that cannot be loaded says why", () => {
  const failure = async (dir: string): Promise<ProjectError> => {
    try {
      await loadProject({ dir })
    } catch (error) {
      if (error instanceof ProjectError) return error
      throw error
    }
    throw new Error("loadProject was expected to refuse this project")
  }

  test("a missing config names the file and the folder", async () => {
    const files = standard()
    delete files["agent.config.ts"]
    const dir = project(files)

    const error = await failure(dir)
    expect(error.message).toContain("agent.config.ts")
    expect(error.message).toContain(dir)
  })

  test("a missing prompt names the file", async () => {
    const files = standard()
    delete files["prompt.md"]

    const error = await failure(project(files))
    expect(error.message).toContain("prompt.md")
  })

  test("an empty prompt is treated as missing, not as a prompt", async () => {
    const files = standard()
    files["prompt.md"] = "   \n"

    const error = await failure(project(files))
    expect(error.message).toContain("prompt.md")
  })

  test("a config file that exports nothing says what to write", async () => {
    const files = standard()
    files["agent.config.ts"] = "export const somethingElse = 1\n"

    const error = await failure(project(files))
    expect(error.message).toContain("export default")
  })

  test("a config that is not valid is reported in the config's own words", async () => {
    const files = standard()
    files["agent.config.ts"] = CONFIG.replace("retentionDays: 365,", "")

    const error = await failure(project(files))
    expect(error.message).toContain("retentionDays")
  })

  test("a tool file that exports no tool is named", async () => {
    const files = standard()
    files["tools/broken.ts"] = "export const notATool = { name: 'nope' }\n"

    const error = await failure(project(files))
    expect(error.message).toContain("broken.ts")
    expect(error.message).toContain("defineTool")
  })

  test("a file that will not even load is named, with the reason", async () => {
    const files = standard()
    files["tools/broken.ts"] = "this is not typescript at all ((\n"

    const error = await failure(project(files))
    expect(error.message).toContain("broken.ts")
  })

  test("every problem is reported in one pass", async () => {
    const dir = project({ "tools/broken.ts": "export const x = 1\n" })

    const error = await failure(dir)
    expect(error.problems.length).toBeGreaterThanOrEqual(3)
    expect(error.message).toContain("agent.config.ts")
    expect(error.message).toContain("prompt.md")
    expect(error.message).toContain("broken.ts")
  })
})
