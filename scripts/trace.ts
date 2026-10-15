// Spec ID coverage. Reads every requirement ID out of Spec.md, looks for a
// test named after it, and prints the ones with no test.
//
// CI runs this as a warning now. From M11 it runs with --strict and fails
// the build on any gap, which turns "does the code do what the Spec says"
// into a report rather than a guess.
//
// Usage: bun run trace [--strict] [--covered]
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..")

/** A requirement as Spec.md declares it: `**CONF-4.** The agent ...` */
export type SpecRequirement = { id: string; section: string }

/**
 * Every ID declared in the Spec, in document order, tagged with the section
 * it sits under. Only the bold-and-dot form counts as a declaration, so an ID
 * merely referred to in passing is not mistaken for a new requirement.
 */
export function specRequirements(markdown: string): SpecRequirement[] {
  const found: SpecRequirement[] = []
  const seen = new Set<string>()
  let section = "(no section)"

  for (const line of markdown.split("\n")) {
    const heading = line.match(/^##\s+(.*?)\s*$/)
    if (heading) {
      section = heading[1]!
      continue
    }
    const declaration = line.match(/^\*\*([A-Z][A-Z0-9]*-\d+)\.\*\*/)
    if (declaration) {
      const id = declaration[1]!
      if (!seen.has(id)) {
        seen.add(id)
        found.push({ id, section })
      }
    }
  }
  return found
}

/**
 * The IDs named by test titles. A test proves a requirement by naming it,
 * as in test("CONF-4: rejects a confirm from another person", ...).
 */
export function idsNamedInTests(sources: string[]): Set<string> {
  const named = new Set<string>()
  // test("..."), it(`...`), test.each(...)("...") and the .skip/.only forms.
  const titleCall = /\b(?:test|it)\s*(?:\.\s*\w+)?\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g
  for (const source of sources) {
    for (const call of source.matchAll(titleCall)) {
      const title = call[2]!
      for (const id of title.matchAll(/\b[A-Z][A-Z0-9]*-\d+\b/g)) named.add(id[0])
    }
  }
  return named
}

/** Every *.test.ts under the given directory. */
function testFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) testFiles(path, found)
    else if (entry.endsWith(".test.ts")) found.push(path)
  }
  return found
}

export type TraceReport = {
  requirements: SpecRequirement[]
  covered: SpecRequirement[]
  uncovered: SpecRequirement[]
  /** IDs a test names that the Spec does not declare: a typo, or a stale ID. */
  unknown: string[]
}

export function trace(markdown: string, testSources: string[]): TraceReport {
  const requirements = specRequirements(markdown)
  const named = idsNamedInTests(testSources)
  const declared = new Set(requirements.map((r) => r.id))

  return {
    requirements,
    covered: requirements.filter((r) => named.has(r.id)),
    uncovered: requirements.filter((r) => !named.has(r.id)),
    unknown: [...named].filter((id) => !declared.has(id)).sort(),
  }
}

export function formatReport(report: TraceReport, showCovered: boolean): string {
  const { requirements, covered, uncovered, unknown } = report
  const out: string[] = []
  const pct =
    requirements.length === 0 ? 0 : Math.round((covered.length / requirements.length) * 100)

  out.push("Spec ID coverage")
  out.push("")
  out.push(`  covered    ${covered.length} / ${requirements.length}  (${pct}%)`)
  out.push(`  uncovered  ${uncovered.length}`)
  out.push("")

  const bySection = (list: SpecRequirement[]) => {
    const groups = new Map<string, string[]>()
    for (const r of list) {
      const ids = groups.get(r.section) ?? []
      ids.push(r.id)
      groups.set(r.section, ids)
    }
    return groups
  }

  if (showCovered && covered.length > 0) {
    out.push("Covered:")
    for (const [section, ids] of bySection(covered)) out.push(`  ${section}\n    ${ids.join(" ")}`)
    out.push("")
  }

  if (uncovered.length > 0) {
    out.push("No test names these:")
    for (const [section, ids] of bySection(uncovered))
      out.push(`  ${section}\n    ${ids.join(" ")}`)
    out.push("")
  }

  if (unknown.length > 0) {
    out.push("Named by a test but not declared in the Spec:")
    out.push(`  ${unknown.join(" ")}`)
    out.push("")
  }

  return out.join("\n")
}

if (import.meta.main) {
  const strict = process.argv.includes("--strict")
  const showCovered = process.argv.includes("--covered")

  const markdown = readFileSync(join(repoRoot, "docs", "Spec.md"), "utf8")
  const sources = testFiles(join(repoRoot, "packages")).map((f) => readFileSync(f, "utf8"))
  const report = trace(markdown, sources)

  console.log(formatReport(report, showCovered))

  if (report.unknown.length > 0) {
    console.log("A test names an ID the Spec does not declare. Fix the name or the Spec.")
    process.exit(1)
  }
  if (report.uncovered.length > 0) {
    if (strict) {
      console.log(`${report.uncovered.length} Spec IDs have no test.`)
      process.exit(1)
    }
    console.log(`${report.uncovered.length} Spec IDs have no test yet. Not a failure until M11.`)
  }
}
