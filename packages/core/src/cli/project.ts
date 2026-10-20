// Loading an agent project from disk, in the layout PKG-3 describes.
//
// `openbox chat` builds the agent from the files the project already has:
// agent.config.ts, prompt.md and a tools folder. Nothing extra to wire, and
// nothing new for the skill to remember. Each path can be pointed
// somewhere else for a project that is laid out differently.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { ConfigError, defineConfig, type OpenboxConfig } from "../config/index.ts"
import type { Tool } from "../tools/index.ts"

/** The files a project is read from, as PKG-3 names them. */
export const PROJECT_FILES = {
  config: "agent.config.ts",
  prompt: "prompt.md",
  tools: "tools",
} as const

export interface LoadProjectOptions {
  /** The project folder. Defaults to where the command was run. */
  dir?: string | undefined
  config?: string | undefined
  prompt?: string | undefined
  tools?: string | undefined
}

export interface LoadedProject {
  dir: string
  config: OpenboxConfig
  prompt: string
  tools: Tool[]
  /** Where each part came from, so a command can say what it loaded. */
  files: { config: string; prompt: string; tools: string[] }
}

/** Every problem with a project, in one error. */
export class ProjectError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    const list = problems.map((problem) => `  - ${problem}`).join("\n")
    super(`This agent project cannot be loaded:\n${list}`)
    this.name = "ProjectError"
    this.problems = problems
  }
}

/**
 * Only `defineTool` produces these two together, so this tells a tool from
 * any other object a file happens to export.
 */
function isTool(value: unknown): value is Tool {
  if (value === null || typeof value !== "object") return false
  const candidate = value as Partial<Tool>
  return (
    typeof candidate.name === "string" &&
    typeof candidate.brainDescription === "string" &&
    typeof candidate.safeParse === "function" &&
    typeof candidate.handler === "function"
  )
}

const under = (dir: string, path: string): string => (isAbsolute(path) ? path : resolve(dir, path))

const say = (dir: string, path: string): string => {
  const inside = relative(dir, path)
  return inside === "" || inside.startsWith("..") ? path : inside
}

/** Imports a module fresh, so a reload in the same process sees edits. */
async function importFile(path: string): Promise<Record<string, unknown>> {
  const url = `${pathToFileURL(path).href}?at=${statSync(path).mtimeMs}`
  return (await import(url)) as Record<string, unknown>
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The config a project exports, validated as `defineConfig` would. */
async function readConfig(
  path: string,
  dir: string,
  problems: string[],
): Promise<OpenboxConfig | undefined> {
  if (!existsSync(path)) {
    problems.push(
      `${say(dir, path)}: not found in ${dir}. A project needs ${PROJECT_FILES.config}, ${PROJECT_FILES.prompt} and a ${PROJECT_FILES.tools} folder`,
    )
    return undefined
  }

  let module: Record<string, unknown>
  try {
    module = await importFile(path)
  } catch (error) {
    problems.push(`${say(dir, path)}: could not be loaded. ${reason(error)}`)
    return undefined
  }

  const exported = module["default"] ?? module["config"]
  if (exported === undefined) {
    problems.push(
      `${say(dir, path)}: exports no config. Add \`export default defineConfig({ ... })\``,
    )
    return undefined
  }

  try {
    // Run through defineConfig either way: a project that exported a plain
    // object gets the same checks and the same defaults as one that did not.
    return defineConfig(exported)
  } catch (error) {
    if (error instanceof ConfigError) {
      problems.push(...error.problems.map((problem) => `${say(dir, path)}: ${problem}`))
      return undefined
    }
    throw error
  }
}

function readPrompt(path: string, dir: string, problems: string[]): string | undefined {
  if (!existsSync(path)) {
    problems.push(
      `${say(dir, path)}: not found in ${dir}. It holds the agent's system prompt (SKILL-8)`,
    )
    return undefined
  }

  const text = readFileSync(path, "utf8")
  if (text.trim() === "") {
    problems.push(`${say(dir, path)}: is empty. It holds the agent's system prompt (SKILL-8)`)
    return undefined
  }
  return text
}

/** Every tool a folder's files export, in a stable order. */
async function readTools(
  toolsDir: string,
  dir: string,
  problems: string[],
): Promise<{ tools: Tool[]; files: string[] }> {
  // A project with no tools can still be chatted with, so a missing folder
  // is not a problem to report.
  if (!existsSync(toolsDir)) return { tools: [], files: [] }

  const files = readdirSync(toolsDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .sort()
    .map((name) => join(toolsDir, name))

  const tools: Tool[] = []
  const seen = new Set<unknown>()

  for (const file of files) {
    let module: Record<string, unknown>
    try {
      module = await importFile(file)
    } catch (error) {
      problems.push(`${say(dir, file)}: could not be loaded. ${reason(error)}`)
      continue
    }

    const found = Object.values(module).filter(isTool)
    if (found.length === 0) {
      problems.push(
        `${say(dir, file)}: exports no tool. Add \`export default defineTool({ ... })\``,
      )
      continue
    }

    for (const tool of found) {
      // The same tool exported twice, as a default and by name, is one tool.
      if (seen.has(tool)) continue
      seen.add(tool)
      tools.push(tool)
    }
  }

  return { tools, files }
}

/** Reads an agent project off disk. Throws `ProjectError` listing everything wrong. */
export async function loadProject(options: LoadProjectOptions = {}): Promise<LoadedProject> {
  const dir = resolve(options.dir ?? process.cwd())
  const configPath = under(dir, options.config ?? PROJECT_FILES.config)
  const promptPath = under(dir, options.prompt ?? PROJECT_FILES.prompt)
  const toolsPath = under(dir, options.tools ?? PROJECT_FILES.tools)

  const problems: string[] = []
  const config = await readConfig(configPath, dir, problems)
  const prompt = readPrompt(promptPath, dir, problems)
  const { tools, files } = await readTools(toolsPath, dir, problems)

  if (problems.length > 0) throw new ProjectError(problems)
  if (config === undefined || prompt === undefined) {
    throw new ProjectError(["the config and the prompt are both required"])
  }

  return {
    dir,
    config,
    prompt,
    tools,
    files: { config: configPath, prompt: promptPath, tools: files },
  }
}
