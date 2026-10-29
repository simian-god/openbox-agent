// SKILL-6: `openbox chat` run the way a builder runs it.
//
// Everything else about chat is tested in process, with the terminal and
// the brain injected. This file runs the real executable with real stdin
// and stdout, because some faults only exist there: the first version of
// this command deadlocked, because loading the agent project imported the
// package, which imported the executable that was still starting up.
//
// No brain is called here, so no key and no network are needed. What is
// proven is that the command starts, reads what is typed, answers, and
// exits.
import { test, expect } from "bun:test"
import { join } from "node:path"
import { describeDatabase, localApiKey, LOCAL_SUPABASE_URL } from "../support/db.ts"
import { envOr } from "../../src/env.ts"

const ROOT = join(import.meta.dir, "..", "..", "..", "..")
const CLI = join(ROOT, "packages", "core", "src", "cli", "index.ts")
const DEMO = join(ROOT, "examples", "demo-agent")

/** Runs the executable with these lines typed into it. */
async function chat(
  typed: string[],
  args: string[] = ["--dir", DEMO],
): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(["bun", CLI, "chat", ...args], {
    cwd: ROOT,
    stdin: new TextEncoder().encode(typed.map((line) => `${line}\n`).join("")),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SUPABASE_URL: envOr("SUPABASE_URL", LOCAL_SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY: envOr("SUPABASE_SERVICE_ROLE_KEY", localApiKey("service_role")),
      // Enough to build the brain. Nothing here ever calls it.
      OPENROUTER_API_KEY: "sk-not-used-by-this-test",
    },
  })

  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, out, err }
}

describeDatabase("the openbox chat executable", () => {
  test("SKILL-6: it starts against the demo agent and leaves on :quit", async () => {
    const { code, out, err } = await chat([":quit"])

    expect(err).toBe("")
    expect(code).toBe(0)
    expect(out).toContain("openbox chat - demo-restaurant")
    expect(out).toContain("1 tool loaded")
  }, 60_000)

  test("SKILL-6: it answers the commands typed into it", async () => {
    const { code, out } = await chat([":help", ":version", ":quit"])

    expect(code).toBe(0)
    expect(out).toContain(":trace")
    expect(out).toMatch(/version [0-9a-f]{64}/)
  }, 60_000)

  test("SKILL-6: input ending is the same as leaving", async () => {
    // No :quit at all. The command must finish, not hang on stdin.
    const { code } = await chat([])
    expect(code).toBe(0)
  }, 60_000)

  test("SKILL-6: a folder with no agent in it fails with a message, not a stack", async () => {
    const { code, out } = await chat([":quit"], ["--dir", join(ROOT, "docs")])

    expect(code).toBe(1)
    expect(out).toContain("agent.config.ts")
    expect(out).not.toContain("at async")
  }, 60_000)
})
