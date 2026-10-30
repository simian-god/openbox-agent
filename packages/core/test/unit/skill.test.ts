// The skill's reference files, which are documents rather than code, so
// what can be tested about them is what the Spec actually promises: that
// they are where SKILL-2 says they are, that they are short enough for
// every command to read before it writes anything, that the prompt
// template has SKILL-8's headings in SKILL-8's order, and that the
// checklist covers every item SKILL-9 lists.
//
// The Spec is the source of truth for all three lists, so the lists are
// read out of `docs/Spec.md` rather than copied here. A Spec edit then
// fails a test instead of quietly leaving the skill behind.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..", "..", "..")
const read = (path: string): string => readFileSync(join(root, path), "utf8")

const BEST_PRACTICES = "skill/references/best-practices.md"
const CHECKLIST = "skill/references/checklist.md"
const TEMPLATE = "skill/references/prompt-template.md"

const spec = read("docs/Spec.md")

/** The text of one Spec rule, up to wherever the next one starts. */
function rule(id: string): string {
  const start = spec.indexOf(`**${id}.**`)
  expect(start).toBeGreaterThan(-1)
  const after = spec.slice(start + id.length + 7)
  const end = after.search(/\n\*\*[A-Z]+-\d+\.\*\*|\n---/)
  return end === -1 ? after : after.slice(0, end)
}

/** SKILL-8's numbered headings, in the Spec's order. */
const specHeadings = [...rule("SKILL-8").matchAll(/^\d+\.\s+(.+)$/gm)].map((match) =>
  (match[1] ?? "").trim(),
)

/** SKILL-9's bullets, each the wording the checklist has to cover. */
const specChecks = [...rule("SKILL-9").matchAll(/^-\s+(.+)$/gm)].map((match) =>
  (match[1] ?? "").trim(),
)

/** Backticks and case are formatting, not content. */
const plain = (text: string): string => text.replace(/`/g, "").toLowerCase()

const words = (text: string): number => text.split(/\s+/).filter((word) => word !== "").length

describe("SKILL-2: what every command reads before it writes anything", () => {
  test("SKILL-2: both files are at the paths the Spec names", () => {
    // A command that reads a path nothing is at reads nothing, and would
    // carry on writing an agent with no guidance behind it.
    expect(existsSync(join(root, BEST_PRACTICES))).toBe(true)
    expect(existsSync(join(root, CHECKLIST))).toBe(true)
  })

  test("SKILL-2: the guidance says what it was condensed from, and when it was read", () => {
    const text = read(BEST_PRACTICES)
    // Condensed guidance goes stale, and a reader cannot tell how stale
    // without the source and the date. Both are named per source.
    expect(text).toContain(
      "https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents",
    )
    expect(text).toContain("https://www.anthropic.com/engineering/writing-tools-for-agents")
    expect(text).toContain("https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6")
    expect(text).toContain("2026-10-30")
  })

  test("SKILL-2: all three are condensed, because every command pays for them", () => {
    // SKILL-2 says every command reads these before writing anything, so
    // their length is a tax on every build. The budget is the rule the
    // guidance itself gives: the smallest set of high signal tokens.
    const counted = {
      guidance: words(read(BEST_PRACTICES)),
      checklist: words(read(CHECKLIST)),
      template: words(read(TEMPLATE)),
    }
    expect(counted.guidance).toBeLessThan(2000)
    expect(counted.checklist).toBeLessThan(2000)
    expect(counted.template).toBeLessThan(1500)
    expect(counted.guidance + counted.checklist + counted.template).toBeLessThan(4500)
  })

  test("SKILL-2: the guidance leaves no placeholder of its own behind", () => {
    expect(read(BEST_PRACTICES)).not.toMatch(/TODO|TBD|FIXME|lorem ipsum|\{\{/i)
  })

  test("SKILL-2: and the checklist names every marker it hunts for", () => {
    // Written as a rule about the checklist's content rather than as the
    // same grep, because the checklist is the one file that has to name
    // these strings: a blanket ban would forbid it from saying what to
    // look for. What matters is that its list is complete, including the
    // double brace the prompt template's holes are written in.
    const text = read(CHECKLIST)
    for (const marker of ["{{", "TODO", "TBD", "FIXME", "lorem ipsum"]) {
      expect(text).toContain(marker)
    }
  })
})

describe("SKILL-8: the prompt template", () => {
  test("SKILL-8: the Spec lists ten headings, which is what the template is held to", () => {
    expect(specHeadings).toHaveLength(10)
    expect(specHeadings[0]).toBe("Identity and goal")
    expect(specHeadings[9]).toBe("Examples")
  })

  test("SKILL-8: the template has those headings, in that order and no others", () => {
    const headings = [...read(TEMPLATE).matchAll(/^##\s+\d+\.\s+(.+)$/gm)].map((match) =>
      (match[1] ?? "").trim(),
    )
    expect(headings).toEqual(specHeadings)
  })

  test("SKILL-8: every section says what goes in it, so it is not ten empty headings", () => {
    const sections = read(TEMPLATE)
      .split(/^##\s+\d+\.\s+/m)
      .slice(1)
    expect(sections).toHaveLength(10)
    for (const section of sections) {
      // The heading line, then something under it worth reading.
      const body = section.slice(section.indexOf("\n") + 1).trim()
      expect(words(body)).toBeGreaterThan(15)
    }
  })

  test("SKILL-8: every placeholder is written one way, so a leftover can be found", () => {
    const text = read(TEMPLATE)
    // The checklist's "no placeholder text" check needs one thing to look
    // for. Anything in double braces is a hole the builder's answer fills.
    expect(text).toMatch(/\{\{[a-z][a-z0-9 _]*\}\}/)
    expect(text).toContain("{{")
    expect(text).not.toMatch(/TODO|TBD|FIXME|lorem ipsum/i)
    // And nothing half written: every opening brace pair is closed.
    const opens = text.split("{{").length - 1
    const closes = text.split("}}").length - 1
    expect(opens).toBe(closes)
  })
})

describe("SKILL-9: the checklist", () => {
  test("SKILL-9: the Spec lists ten checks, which is the floor the checklist meets", () => {
    expect(specChecks).toHaveLength(10)
  })

  test("SKILL-9: every check the Spec lists is in the checklist, in the Spec's own words", () => {
    const text = plain(read(CHECKLIST))
    const missing = specChecks.filter((check) => !text.includes(plain(check)))
    expect(missing).toEqual([])
  })

  test("SKILL-9: every item says how it fails, so none of them is a slogan", () => {
    const text = read(CHECKLIST)
    const items = [...text.matchAll(/^##\s+\d+\.\s+/gm)].length
    expect(items).toBeGreaterThanOrEqual(10)
    // One "Fails when" per item, because an item a reader cannot fail is
    // an item that always passes.
    expect([...text.matchAll(/^\*\*Fails when\.\*\*/gm)]).toHaveLength(items)
  })
})
