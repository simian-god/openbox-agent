// A variable that is declared and left empty must behave as if it were
// absent, because that is what .env.example tells a builder it does.
//
// This is not hypothetical. Every variable in that template ships empty,
// two of them say in their own comment that empty means "fall back", and
// the first live run on a fresh .env failed with OpenRouter's "No models
// provided": the model came from `process.env["OPENBOX_LIVE_MODEL"] ??` a
// default, had been given the empty string, which is a value, so the
// default never ran and the request carried no model at all.
import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { envOr, envValue } from "../../src/env.ts"
import { tsFiles, withoutComments } from "../support/source.ts"

test("REL-2: a missing variable has no value", () => {
  expect(envValue("OB_TEST_ABSENT", {})).toBeUndefined()
  expect(envOr("OB_TEST_ABSENT", "fallback", {})).toBe("fallback")
})

test("REL-2: a declared but empty variable counts as missing", () => {
  const env = { OB_TEST_EMPTY: "" }
  expect(envValue("OB_TEST_EMPTY", env)).toBeUndefined()
  expect(envOr("OB_TEST_EMPTY", "fallback", env)).toBe("fallback")
})

test("REL-2: a whitespace only variable counts as missing", () => {
  for (const blank of [" ", "   ", "\t", "\n", " \r\n "]) {
    const env = { OB_TEST_BLANK: blank }
    expect(envValue("OB_TEST_BLANK", env)).toBeUndefined()
    expect(envOr("OB_TEST_BLANK", "fallback", env)).toBe("fallback")
  }
})

test("REL-2: a real value wins over the fallback, trimmed", () => {
  expect(envOr("OB_TEST_SET", "fallback", { OB_TEST_SET: "value" })).toBe("value")
  // A key pasted with a stray newline is the same key.
  expect(envOr("OB_TEST_SET", "fallback", { OB_TEST_SET: " sk-abc\n" })).toBe("sk-abc")
})

test("REL-2: the real environment is the default source", () => {
  const name = "OB_TEST_REAL_ENV"
  try {
    // Read a value that is really there, so a default source of `{}`
    // cannot pass this by returning undefined for everything.
    process.env[name] = "value"
    expect(envValue(name)).toBe("value")
    expect(envOr(name, "fallback")).toBe("value")
    process.env[name] = ""
    expect(envValue(name)).toBeUndefined()
    expect(envOr(name, "fallback")).toBe("fallback")
  } finally {
    delete process.env[name]
  }
})

// The structural half, in the shape DEP-1 and DATA-1 are already enforced
// in: a rule about what the code may do, checked by reading the code. The
// other direction, that every variable the code reads is declared in
// .env.example, is already held by repo.test.ts.
//
// Comments are stripped but string literals are kept, which matters: the
// fallback that actually broke the live run was a literal model id, so a
// scan that blanked strings could not tell it from the one shape that is
// allowed. `?? ""` is allowed, because an empty variable falling back to
// an empty string changes nothing and every caller that does it checks
// for empty next.
const root = join(import.meta.dir, "..", "..", "..", "..")
const SCANNED = ["packages", "scripts", "examples"]
const SELF = "packages/core/test/unit/env.test.ts"

/** The pattern, shared so the rule and its own proof cannot drift apart. */
const DEFAULTED =
  /(?:process|Bun)\.env(?:\[["']([A-Z][A-Z0-9_]*)["']\]|\.([A-Z][A-Z0-9_]*))\s*(\?\?|\|\|)\s*("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|\S+)/g

/** Each offending read as `file:line (NAME ?? fallback)`. */
function hits(text: string, label = ""): string[] {
  const stripped = withoutComments(text)
  const found: string[] = []
  for (const match of stripped.matchAll(DEFAULTED)) {
    const fallback = match[4] as string
    if (fallback === '""' || fallback === "''" || fallback === "``") continue
    const name = match[1] ?? match[2]
    const where =
      label === "" ? "" : `${label}:${stripped.slice(0, match.index).split("\n").length} `
    found.push(`${where}(${name} ${match[3]} ${fallback})`)
  }
  return found
}

test("REL-2: no environment variable is given a default with ?? or ||", () => {
  const offenders: string[] = []
  let scanned = 0
  for (const dir of SCANNED) {
    for (const file of tsFiles(join(root, dir))) {
      if (file.includes("node_modules")) continue
      const rel = `${dir}/${file}`
      // The module whose whole job is this, and this file, which quotes
      // the forbidden shape on purpose to prove the rule can fail.
      if (rel.endsWith("packages/core/src/env.ts") || rel.endsWith(SELF)) continue
      scanned++
      offenders.push(...hits(readFileSync(join(root, dir, file), "utf8"), rel))
    }
  }
  expect(offenders).toEqual([])
  // A scan that reads nothing passes every rule. This is the floor that
  // says it really looked, and it caught a probe that skipped every file.
  expect(scanned).toBeGreaterThan(100)
})

test("REL-2: that rule can actually fail", () => {
  // A rule enforced by reading source is worth exactly as much as its
  // regex, so this proves the regex catches every shape it forbids and
  // passes the one it allows, rather than waiting for somebody to
  // reintroduce the bug and find out then.
  expect(hits('const a = process.env["X"] ?? LOCAL_URL')).toEqual(["(X ?? LOCAL_URL)"])
  expect(hits('const a = process.env["X"] ?? "openai/gpt-4o-mini"')).toEqual([
    '(X ?? "openai/gpt-4o-mini")',
  ])
  expect(hits("const a = process.env.X ?? LOCAL_URL")).toEqual(["(X ?? LOCAL_URL)"])
  expect(hits('const a = process.env["X"] || LOCAL_URL')).toEqual(["(X || LOCAL_URL)"])
  expect(hits('const a = Bun.env["X"] ?? LOCAL_URL')).toEqual(["(X ?? LOCAL_URL)"])
  // Whitespace between the read and the fallback must not let it through,
  // which an earlier version of this regex did: a lookahead after \s*
  // simply backtracked to zero spaces and matched.
  expect(hits('const a = process.env["X"]   ??\n    LOCAL_URL')).toEqual(["(X ?? LOCAL_URL)"])

  // The shapes that are fine.
  expect(hits('const a = process.env["X"] ?? ""')).toEqual([])
  expect(hits('const a = envOr("X", LOCAL_URL)')).toEqual([])
  expect(hits('// const a = process.env["X"] ?? LOCAL_URL')).toEqual([])
})
