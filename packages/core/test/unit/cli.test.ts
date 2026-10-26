import { test, expect } from "bun:test"
import { parseArgs } from "../../src/cli/index.ts"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Argument parsing, and that every command the usage text offers is a
// command the switch below it actually has. PKG-2 is about what the public
// entry exports, which is proven once createAgent exists.

test("cli: the cli reads a command and its options", () => {
  const { command, flags } = parseArgs(["migrate", "--migrations", "db/migrations"])

  expect(command).toBe("migrate")
  expect(flags.get("migrations")).toBe("db/migrations")
})

test("cli: a flag with no value is a yes", () => {
  const { command, flags } = parseArgs(["migrate", "--help"])

  expect(command).toBe("migrate")
  expect(flags.get("help")).toBe("true")
  expect(flags.has("migrations")).toBe(false)
})

test("cli: a flag before the command is still read", () => {
  const { command, flags } = parseArgs(["--database-url", "postgres://x/y", "migrate"])

  expect(command).toBe("migrate")
  expect(flags.get("database-url")).toBe("postgres://x/y")
})

test("ROLE-2: the words after the command are kept, in order", () => {
  // `openbox operator add whatsapp 9198...` is a command and three words.
  // A flag for each would be a worse way to write the same thing, so the
  // parser keeps the bare words and the command stays the first of them.
  const { command, args, flags } = parseArgs([
    "operator",
    "add",
    "whatsapp",
    "919812345678",
    "--dir",
    "agents/restaurant",
  ])

  expect(command).toBe("operator")
  expect(args).toEqual(["operator", "add", "whatsapp", "919812345678"])
  expect(flags.get("dir")).toBe("agents/restaurant")
})

test("cli: no arguments means no command", () => {
  expect(parseArgs([]).command).toBeUndefined()
})

test("cli: every command the usage text offers is one the switch handles", () => {
  // This exists because `tune` was added to the usage text and not to the
  // switch, so `openbox tune` printed "Unknown command: tune" under a help
  // screen that advertised it.
  //
  // Read rather than run. Calling each command would mean migrate reaching
  // for a real database and chat reaching for stdin, and a test that can
  // touch either is a test nobody will keep.
  const source = readFileSync(join(import.meta.dir, "..", "..", "src", "cli", "index.ts"), "utf8")

  const usage = source.slice(source.indexOf("const USAGE"), source.indexOf("/** Reads --name"))
  const offered = [...usage.matchAll(/^ {2}openbox (\w+)/gm)].map((match) => match[1])
  const handled = [...source.matchAll(/^ {4}case "(\w+)":/gm)].map((match) => match[1])

  expect(offered.length).toBeGreaterThan(1)
  expect([...offered].sort()).toEqual([...handled].sort())
})
