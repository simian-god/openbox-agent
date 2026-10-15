// DEP-1 enforced mechanically: the core reaches the outside world only
// through injected providers. Nothing outside src/providers may call fetch
// or build a client when the module loads.
import { test, expect } from "bun:test"
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"

const coreSrc = join(import.meta.dir, "..", "src")
const providersPrefix = "providers/"

// Files under src, as paths relative to src, with the providers tree split out.
function sourceFiles(dir = "", found: string[] = []): string[] {
  const abs = join(coreSrc, dir)
  if (!existsSync(abs)) return found
  for (const entry of readdirSync(abs)) {
    const rel = dir ? `${dir}/${entry}` : entry
    if (statSync(join(coreSrc, rel)).isDirectory()) sourceFiles(rel, found)
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) found.push(rel)
  }
  return found
}

const outsideProviders = () => sourceFiles().filter((f) => !f.startsWith(providersPrefix))

// Strip comments and string literals so the word "fetch" in prose or in an
// error message doesn't count as a call.
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
}

test("DEP-1: nothing outside src/providers calls fetch", () => {
  const offenders: string[] = []
  for (const file of outsideProviders()) {
    const text = code(readFileSync(join(coreSrc, file), "utf8"))
    for (const match of text.matchAll(/\b(?:globalThis\.|window\.)?fetch\s*\(/g)) {
      const line = text.slice(0, match.index).split("\n").length
      offenders.push(`${file}:${line}`)
    }
  }
  expect(offenders).toEqual([])
})

// Constructing one of these when a module loads is harmless: no socket, no
// key, no I/O. Anything else at module level is treated as a client.
const pureBuiltins = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "Uint8Array",
  "Int32Array",
  "Float64Array",
  "ArrayBuffer",
  "Intl",
])

test("DEP-1: nothing outside src/providers builds a client at module level", () => {
  const offenders: string[] = []
  for (const file of outsideProviders()) {
    const lines = code(readFileSync(join(coreSrc, file), "utf8")).split("\n")
    lines.forEach((line, i) => {
      // Module level means column zero: anything indented sits inside a
      // function or class and runs only when that code is called.
      if (/^\s/.test(line)) return
      const built = line.match(
        /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*new\s+(\w+)\s*\(/,
      )
      if (built && !pureBuiltins.has(built[1]!)) {
        offenders.push(`${file}:${i + 1} (new ${built[1]})`)
      }
      const made = line.match(
        /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(create[A-Z]\w*)\s*\(/,
      )
      if (made) offenders.push(`${file}:${i + 1} (${made[1]}())`)
    })
  }
  expect(offenders).toEqual([])
})
