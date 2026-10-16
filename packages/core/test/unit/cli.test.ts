import { test, expect } from "bun:test"
import { parseArgs } from "../../src/cli/index.ts"

// Argument parsing only. PKG-2 is about what the public entry exports,
// which is proven once createAgent exists.

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

test("cli: no arguments means no command", () => {
  expect(parseArgs([]).command).toBeUndefined()
})
