#!/usr/bin/env bun
// The `openbox` command. Four subcommands by the end; `migrate` is the
// first. Hand written argument parsing, since four commands need no
// framework.
import { join } from "node:path"
import { migrate, MigrateError } from "../migrate/index.ts"

const USAGE = `openbox - tools for an openbox-agent project

Usage:
  openbox migrate [options]    apply the core migrations, then the agent's

Options for migrate:
  --database-url <url>   Postgres connection. Defaults to DATABASE_URL
  --migrations <dir>     the agent's migrations. Defaults to db/migrations
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
    default:
      console.error(`Unknown command: ${command}\n`)
      console.log(USAGE)
      return 1
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)))
}
