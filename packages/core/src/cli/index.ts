#!/usr/bin/env bun
// The `openbox` command. Four subcommands by the end; `migrate` is the
// first. Hand written argument parsing, since four commands need no
// framework.
//
// Nothing imports this file: it is the executable, and each command lives
// in its own module. `chat` loads the agent project, which imports
// openbox-agent, which re exports from cli/public.ts rather than from
// here. Both parts matter. With this file in that circle, and a top level
// `await` below, loading the project waits on an executable that is
// waiting on the project, and the command hangs with no output at all.
import { join } from "node:path"
import { migrate, MigrateError } from "../migrate/index.ts"
import { runChat } from "./chat.ts"

const USAGE = `openbox - tools for an openbox-agent project

Usage:
  openbox migrate [options]    apply the core migrations, then the agent's
  openbox chat [options]       talk to the agent in this folder

Options for migrate:
  --database-url <url>   Postgres connection. Defaults to DATABASE_URL
  --migrations <dir>     the agent's migrations. Defaults to db/migrations

Options for chat:
  --dir <dir>            the agent project. Defaults to this folder
  --config <file>        defaults to agent.config.ts
  --prompt <file>        defaults to prompt.md
  --tools <dir>          defaults to tools
  --as <id>              who is typing. Defaults to "local"

  --help                 show this
`

/** Reads --name value pairs and bare flags. */
export function parseArgs(argv: string[]): { command?: string; flags: Map<string, string> } {
  const flags = new Map<string, string>()
  let command: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue

    if (arg.startsWith("--")) {
      const name = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next)
        i++
      } else {
        flags.set(name, "true")
      }
    } else if (command === undefined) {
      command = arg
    }
  }

  return command === undefined ? { flags } : { command, flags }
}

async function runMigrate(flags: Map<string, string>): Promise<number> {
  const databaseUrl = flags.get("database-url") ?? process.env["DATABASE_URL"]
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error("No database. Set DATABASE_URL, or pass --database-url.")
    return 1
  }

  const agentMigrationsDir = flags.get("migrations") ?? join(process.cwd(), "db", "migrations")

  try {
    const result = await migrate({
      databaseUrl,
      agentMigrationsDir,
      log: (line) => console.log(line),
    })

    if (result.applied.length === 0) {
      console.log(`Nothing to apply. ${result.skipped.length} migrations already run.`)
    } else {
      console.log(`Applied ${result.applied.length}, skipped ${result.skipped.length}.`)
    }
    console.log(`Row level security is on for all ${result.tablesChecked} tables.`)
    return 0
  } catch (error) {
    if (error instanceof MigrateError) {
      console.error(error.message)
      return 1
    }
    throw error
  }
}

export async function run(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv)

  if (command === undefined || flags.has("help")) {
    console.log(USAGE)
    return command === undefined ? 1 : 0
  }

  switch (command) {
    case "migrate":
      return runMigrate(flags)
    case "chat":
      return runChat({
        ...(flags.has("dir") ? { dir: flags.get("dir") } : {}),
        ...(flags.has("config") ? { config: flags.get("config") } : {}),
        ...(flags.has("prompt") ? { prompt: flags.get("prompt") } : {}),
        ...(flags.has("tools") ? { tools: flags.get("tools") } : {}),
        ...(flags.has("as") ? { as: flags.get("as") } : {}),
      })
    default:
      console.error(`Unknown command: ${command}\n`)
      console.log(USAGE)
      return 1
  }
}

if (import.meta.main) {
  // No top level `await`: see the note at the top of this file.
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
