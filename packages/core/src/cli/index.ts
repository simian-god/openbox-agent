#!/usr/bin/env bun
// The `openbox` command. `migrate` was the first. Hand written argument
// parsing, since a handful of commands need no framework.
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
import { runTune } from "./tune.ts"
import { runOperator } from "./operator.ts"

const USAGE = `openbox - tools for an openbox-agent project

Usage:
  openbox migrate [options]    apply the core migrations, then the agent's
  openbox chat [options]       talk to the agent in this folder
  openbox tune [options]       measure where the routing threshold belongs
  openbox operator add <channel> <id>
                               make someone an operator of this agent

Options for migrate:
  --database-url <url>   Postgres connection. Defaults to DATABASE_URL
  --migrations <dir>     the agent's migrations. Defaults to db/migrations

Options for chat:
  --dir <dir>            the agent project. Defaults to this folder
  --config <file>        defaults to agent.config.ts
  --prompt <file>        defaults to prompt.md
  --tools <dir>          defaults to tools
  --as <id>              who is typing. Defaults to "local"

Options for tune:
  --dir <dir>            the agent project. Defaults to this folder
  --tolerance <n>        the share of examples that may lose their tool.
                         Defaults to 0.01, one in a hundred
  --examples <file>      defaults to examples/routing.jsonl
  --write                set routeThreshold in agent.config.ts. Off by
                         default: nothing changes the agent unless you say so

Options for operator:
  --dir <dir>            the agent project. Defaults to this folder
  --config <file>        defaults to agent.config.ts

  --help                 show this
`

/**
 * Reads --name value pairs, bare flags, and the words in between.
 *
 * `args` is every bare word in order, the command first, because
 * `operator add whatsapp 9198...` is three of them and a flag for each
 * would be a worse way to write the same thing.
 */
export function parseArgs(argv: string[]): {
  command?: string
  args: string[]
  flags: Map<string, string>
} {
  const flags = new Map<string, string>()
  const args: string[] = []
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
    } else {
      args.push(arg)
      if (command === undefined) command = arg
    }
  }

  return command === undefined ? { args, flags } : { command, args, flags }
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
  const { command, args, flags } = parseArgs(argv)

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
    case "tune": {
      const tolerance = flags.get("tolerance")
      const asNumber = tolerance === undefined ? undefined : Number(tolerance)
      if (asNumber !== undefined && (Number.isNaN(asNumber) || asNumber < 0 || asNumber > 1)) {
        console.error(`--tolerance must be a share between 0 and 1, not "${tolerance}".`)
        return 1
      }
      return runTune({
        ...(flags.has("dir") ? { dir: flags.get("dir") } : {}),
        ...(flags.has("config") ? { config: flags.get("config") } : {}),
        ...(flags.has("tools") ? { tools: flags.get("tools") } : {}),
        ...(flags.has("examples") ? { examplesFile: flags.get("examples") } : {}),
        ...(asNumber !== undefined ? { tolerance: asNumber } : {}),
        ...(flags.has("write") ? { write: true } : {}),
      })
    }
    case "operator":
      return runOperator({
        // Everything after `operator`, so the subcommand and its two words.
        args: args.slice(1),
        ...(flags.has("dir") ? { dir: flags.get("dir") } : {}),
        ...(flags.has("config") ? { config: flags.get("config") } : {}),
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
