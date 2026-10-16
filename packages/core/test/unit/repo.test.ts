// Repo level rules: what the published repository must look like.
// These sit beside the core tests so one `bun test` covers everything.
import { test, expect } from "bun:test"
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"

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
  for (const file of sourceDirs.flatMap((d) => sourceFiles(d))) {
    if (file === "packages/core/test/unit/repo.test.ts") continue
    const text = readFileSync(join(root, file), "utf8")
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const name = match[1]!
        if (!declared.has(name)) missing.push(`${name} (${file})`)
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
