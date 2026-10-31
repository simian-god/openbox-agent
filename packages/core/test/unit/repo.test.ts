// Repo level rules: what the published repository must look like.
// These sit beside the core tests so one `bun test` covers everything.
import { test, expect } from "bun:test"
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { code } from "../support/source.ts"

const root = join(import.meta.dir, "..", "..", "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")

// Source trees that may read the environment. Anything outside these is not
// shipped, so it has no claim on .env.example.
const sourceDirs = ["packages", "skill", "examples", "scripts", "install"]
const sourceExts = [".ts", ".tsx", ".js", ".mjs", ".sh", ".ps1", ".sql", ".yml", ".yaml"]
const skipDirs = new Set(["node_modules", "dist", ".git", ".supabase"])

function sourceFiles(dir: string, found: string[] = []): string[] {
  const abs = join(root, dir)
  if (!existsSync(abs)) return found
  for (const entry of readdirSync(abs)) {
    if (skipDirs.has(entry)) continue
    const rel = `${dir}/${entry}`
    if (statSync(join(root, rel)).isDirectory()) sourceFiles(rel, found)
    else if (sourceExts.some((e) => entry.endsWith(e))) found.push(rel)
  }
  return found
}

test("REL-1: the workspace holds the core package, the skill and the example agent", () => {
  const workspaces = JSON.parse(read("package.json")).workspaces as string[]
  expect(workspaces).toContain("packages/*")
  expect(workspaces).toContain("examples/*")

  expect(JSON.parse(read("packages/core/package.json")).name).toBe("openbox-agent")
  expect(JSON.parse(read("examples/demo-agent/package.json")).name).toBe("demo-agent")

  // Checked for content, not just existence: git does not track an empty
  // directory, so an empty skill/ is there on this machine and missing from
  // a fresh clone.
  expect(existsSync(join(root, "skill"))).toBe(true)
  expect(readdirSync(join(root, "skill")).length).toBeGreaterThan(0)
})

test("REL-1: the repo is published under the MIT license", () => {
  expect(read("LICENSE")).toContain("MIT License")
  expect(JSON.parse(read("packages/core/package.json")).license).toBe("MIT")
})

test("REL-2: .env.example lists every environment variable the source reads", () => {
  const declared = new Set(
    read(".env.example")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split("=")[0]!.trim()),
  )

  const missing: string[] = []
  // process.env.NAME, process.env["NAME"], Bun.env.NAME, and shell $NAME forms.
  const patterns = [
    /(?:process|Bun)\.env\.([A-Z][A-Z0-9_]*)/g,
    /(?:process|Bun)\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
  ]
  // Two files name variables that do not exist on purpose: this one, and
  // env.test.ts, which quotes the shape `process.env["X"] ?? default` to
  // prove its own rule against that shape can fail.
  const quotesFakeNames = new Set([
    "packages/core/test/unit/repo.test.ts",
    "packages/core/test/unit/env.test.ts",
  ])
  // Names the operating system provides rather than the builder: nobody
  // puts PATH in a .env, and a rule that asked them to would be ignored
  // instead of followed. .env.example is for the keys and the settings
  // somebody has to fill in. Everything outside this list is declared.
  const fromTheOs = new Set(["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "SHELL"])
  for (const file of sourceDirs.flatMap((d) => sourceFiles(d))) {
    if (quotesFakeNames.has(file)) continue
    const text = readFileSync(join(root, file), "utf8")
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const name = match[1]!
        if (!declared.has(name) && !fromTheOs.has(name)) missing.push(`${name} (${file})`)
      }
    }
  }
  expect(missing).toEqual([])
})

test("REL-2: no secret file can be committed by accident", () => {
  const ignored = read(".gitignore")
  expect(ignored).toContain(".env")
  expect(ignored).toContain("!.env.example")
})

test("TIME-1: only the clock itself reads the system clock", () => {
  // Enforced by structure rather than by discipline, the same way DEP-1 is.
  // The reason is a real failure: in the M1 live run a tool took a raw date,
  // the brain worked out which day Friday was, got it wrong, and told
  // someone Sunday's opening hours. Every time in the core comes from the
  // injected clock, so a test can freeze it and a server's timezone can
  // never change an answer.
  //
  // `systemClock` is the one place the real clock is read. That is what it
  // is for, and it is injected like anything else.
  const allowed = new Set(["packages/core/src/testing/clock.ts"])

  const reads: string[] = []
  for (const file of sourceFiles("packages/core/src").concat(sourceFiles("examples"))) {
    if (allowed.has(file) || !file.endsWith(".ts")) continue
    // Comments and strings stripped, so a rule about what the code calls is
    // not tripped by a comment explaining the rule.
    const body = code(read(file))
    if (/\bDate\.now\s*\(/.test(body) || /new\s+Date\s*\(\s*\)/.test(body)) {
      reads.push(file)
    }
  }

  expect(reads).toEqual([])
})

test("PKG-1: a heavy brain's package is optional, and nothing imports it eagerly", () => {
  // The Claude Agent SDK ships a platform binary of about 289 MB. As a
  // plain dependency, every agent built on this core downloads it to run
  // on OpenRouter. So it is an optional peer dependency.
  //
  // Both halves are checked, because either one alone is useless. The
  // package.json decides whether it is downloaded. A static import would
  // make it load at startup and fail the whole core when it is absent,
  // whatever package.json says.
  const pkg = JSON.parse(read("packages/core/package.json")) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
  }
  const heavy = "@anthropic-ai/claude-agent-sdk"

  expect(Object.keys(pkg.dependencies ?? {})).not.toContain(heavy)
  expect(pkg.peerDependencies?.[heavy]).toBeDefined()
  expect(pkg.peerDependenciesMeta?.[heavy]?.optional).toBe(true)

  // And only the brain that needs it mentions it, dynamically.
  const importers = sourceFiles("packages/core/src").filter((file) => read(file).includes(heavy))
  expect(importers).toEqual(["packages/core/src/providers/brains/claude-agent-sdk.ts"])

  const brain = read(importers[0] as string)
  expect(brain).toContain(`await import("${heavy}")`)
  expect(brain).not.toContain(`from "${heavy}"`)
})

test("K14: every integration test builds its agents through the registry", () => {
  // Step 2 of Known K14. The suspect for the intermittent stall is an
  // agent escaping its file's cleanup and carrying on polling the shared
  // database, where it both slows everything down and claims rows another
  // file is waiting for. Every file used to keep its own `started` array,
  // so nothing could see across them.
  //
  // The registry fixes that by construction rather than by vigilance, but
  // only for the files that use it. This is the rule that keeps the next
  // one from quietly going back.
  const files = sourceFiles("packages/core/test/integration").filter((file) =>
    file.endsWith(".test.ts"),
  )
  expect(files.length).toBeGreaterThan(10)

  const untracked: string[] = []
  const handRolled: string[] = []
  for (const file of files) {
    const body = read(file)
    if (!body.includes("createAgent")) continue
    if (!body.includes('from "../support/agents.ts"')) untracked.push(file)
    // The old shape, which a copied file would bring back with it.
    if (body.includes("started.splice(")) handRolled.push(file)
  }

  expect(untracked).toEqual([])
  expect(handRolled).toEqual([])
})
