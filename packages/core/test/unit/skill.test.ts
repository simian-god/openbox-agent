// The skill itself, which is documents rather than code, so what can be
// tested about it is what the Spec actually promises: that the files are
// where SKILL-2 says they are, that they are short enough for every
// command to read before it writes anything, that the prompt template has
// SKILL-8's headings in SKILL-8's order, that the checklist covers every
// item SKILL-9 lists, and that `SKILL.md` carries every command SKILL-1
// names, every step SKILL-3 lists in SKILL-3's order, and every question
// SKILL-11 asks.
//
// The Spec is the source of truth for all of those lists, so they are read
// out of `docs/Spec.md` rather than copied here. A Spec edit then fails a
// test instead of quietly leaving the skill behind.
//
// What a test cannot do here is run the skill: a skill is instructions for
// an agent, and whether an agent follows them is C22, which is the M10
// check building the demo agent from scratch. These tests hold the
// instructions to the Spec. They do not pretend to prove obedience.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "..", "..", "..")
const read = (path: string): string => readFileSync(join(root, path), "utf8")

const SKILL = "skill/SKILL.md"
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

/** SKILL-1's commands, as the Spec backticks them. */
const specCommands = [...rule("SKILL-1").matchAll(/`([a-z][a-z-]*)`/g)].map((match) => match[1])

/** SKILL-3's six steps, in the Spec's order. */
const specSteps = [...rule("SKILL-3").matchAll(/^\d+\.\s+(.+)$/gm)].map((match) =>
  (match[1] ?? "").trim(),
)

/** SKILL-11's five questions, in the Spec's order. */
const specQuestions = [...rule("SKILL-11").matchAll(/^\d+\.\s+(.+)$/gm)].map((match) =>
  (match[1] ?? "").trim(),
)

/** PKG-3's project layout: the paths the skill has to write. */
const specPaths = [...rule("PKG-3").matchAll(/^ {2}(\S+)[ \t]+\S/gm)].map((match) => match[1] ?? "")

/** One `## ` section of a document, heading included. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`)
  expect(start).toBeGreaterThan(-1)
  const after = text.slice(start + 3)
  const end = after.indexOf("\n## ")
  return end === -1 ? after : after.slice(0, end)
}

/** One `### n.` step of the `new` flow, heading included. */
function step(number: number): string {
  const flow = section(read(SKILL), "`new`")
  const start = flow.indexOf(`### ${number}.`)
  expect(start).toBeGreaterThan(-1)
  const after = flow.slice(start + 4)
  const end = after.search(/\n### /)
  return end === -1 ? after : after.slice(0, end)
}

/** Whether the document says one thing before another. */
function inOrder(text: string, ...parts: string[]): boolean {
  let at = -1
  for (const part of parts) {
    const found = text.indexOf(part, at + 1)
    if (found <= at) return false
    at = found
  }
  return true
}

describe("SKILL-1: the skill and its commands", () => {
  test("SKILL-1: it is one skill, named so a host can find it", () => {
    const text = read(SKILL)
    // Both hosts read the same front matter, two fields of it. Checked
    // against the skills installed on this machine rather than assumed.
    expect(text.startsWith("---\n")).toBe(true)
    const front = text.slice(4, text.indexOf("\n---", 4))
    expect(front).toContain("name: openboxagent")
    expect(/description: \S/.test(front)).toBe(true)
  })

  test("SKILL-1: every command the Spec lists has its own section, and no others", () => {
    const text = read(SKILL)
    expect(specCommands).toEqual(["new", "add-tool", "swap", "chat", "review", "tune"])
    const headings = [...text.matchAll(/^## `([a-z][a-z-]*)`/gm)].map((match) => match[1])
    expect(headings).toEqual(specCommands)
  })

  test("SKILL-1: with no command it asks which one, rather than guessing", () => {
    expect(plain(read(SKILL))).toContain("no command")
  })

  test("SKILL-2: the references are read before anything is written, said once and up front", () => {
    const text = read(SKILL)
    expect(text).toContain(BEST_PRACTICES.replace("skill/", ""))
    expect(text).toContain(CHECKLIST.replace("skill/", ""))
    // Before the first command, because a rule stated after the commands
    // is a rule read after the writing has started.
    expect(inOrder(text, "references/best-practices.md", "## `new`")).toBe(true)
  })

  test("SKILL-1: the skill is short enough to be read on every invocation", () => {
    expect(words(read(SKILL))).toBeLessThan(2500)
  })
})

describe("SKILL-3: the `new` flow", () => {
  test("SKILL-3: the Spec lists six steps, which is what `new` is held to", () => {
    expect(specSteps).toHaveLength(6)
  })

  test("SKILL-3: `new` has those six steps, numbered in the Spec's order", () => {
    const steps = [...section(read(SKILL), "`new`").matchAll(/^### \d+\.\s+(.+)$/gm)]
    expect(steps).toHaveLength(6)
  })

  test("SKILL-3: step 1 checks grilling is installed and stops with the install command", () => {
    const text = step(1)
    // The real marketplace this machine's own grilling skill came from,
    // read out of ~/.claude/plugins/known_marketplaces.json rather than
    // guessed: github mattpocock/skills, plugin mattpocock-skills.
    expect(text).toContain("grilling")
    expect(text).toContain("/plugin marketplace add mattpocock/skills")
    expect(text).toContain("/plugin install mattpocock-skills")
    expect(plain(text)).toContain("stop")
  })

  test("SKILL-3: step 2's top branches are the ones the Spec names", () => {
    const text = plain(step(2))
    for (const branch of ["tools", "data", "channels", "operators", "personal data"]) {
      expect(text).toContain(branch)
    }
    // The headings are not relisted here: the template is the one copy.
    expect(text).toContain("prompt-template.md")
  })

  test("SKILL-3: step 3 writes nothing until the frontier is empty and the builder agrees", () => {
    // Read out of step 3 alone. Step 2 describes grilling's rounds, so a
    // test that greps the whole flow for "frontier" passes with step 3's
    // own rule deleted, which is how this started.
    const text = plain(step(3))
    expect(text).toContain("frontier")
    expect(text).toContain("shared understanding")
  })

  // The layout is PKG-3's, read out of the Spec. The test is named for
  // SKILL-3 and not for PKG-3 on purpose: this proves the instructions
  // name every file, and nothing here writes a project. PKG-3 is earned
  // when one is built, which is the M10 check.
  test("SKILL-3: step 4 writes every file the Spec's project layout lists", () => {
    const text = step(4)
    expect(specPaths.length).toBeGreaterThanOrEqual(9)
    const missing = specPaths.filter((path) => !text.includes(path))
    expect(missing).toEqual([])
  })

  test("SKILL-3: step 4 holds every tool to the same bar", () => {
    const text = plain(step(4))
    for (const part of [
      "risk",
      "roles",
      "callwhen",
      "dontcallwhen",
      "confirmsummary",
      "5 should",
      "5 shouldnot",
      "confirm buttons",
    ]) {
      expect(text).toContain(part)
    }
  })

  test("SKILL-3: step 5 runs the checklist over its own output and shows the result", () => {
    const text = plain(step(5))
    expect(text).toContain("checklist.md")
    expect(inOrder(text, "checklist.md", "show")).toBe(true)
  })

  test("SKILL-3: step 6 names the environment, then migrate, then chat, in that order", () => {
    const text = step(6)
    expect(inOrder(plain(text), ".env", "openbox migrate", "openbox chat")).toBe(true)
  })
})

describe("SKILL-11 and SKILL-12: the personal data round", () => {
  test("SKILL-11: the Spec asks five questions, which is what the round is held to", () => {
    expect(specQuestions).toHaveLength(5)
  })

  test("SKILL-11: it asks all five, in the Spec's order, before config is written", () => {
    const text = plain(section(read(SKILL), "The personal data round"))
    // One phrase per question, in order, because the order is the point:
    // the notice is drafted from the answers above it, and the category
    // question is the one that stops the flow.
    const asked = ["end up holding", "how long", "first contact notice", "erased", "children"]
    expect(inOrder(text, ...asked)).toBe(true)
    expect(text).toContain("before")
    expect(text).toContain("agent.config.ts")
  })

  test("SKILL-11: a yes to the fifth question stops the flow, and says why", () => {
    const text = plain(section(read(SKILL), "The personal data round"))
    for (const part of ["health", "financial", "government id", "children"]) {
      expect(text).toContain(part)
    }
    expect(text).toContain("lawyer")
    // And then carries on with the builder's own numbers, rather than
    // refusing to build anything.
    expect(text).toContain("carry on")
  })

  test("SKILL-12: the answers are written to the agent's own privacy file", () => {
    const text = plain(section(read(SKILL), "The personal data round"))
    expect(text).toContain("docs/privacy.md")
    for (const part of ["date", "number", "categor", "not been reviewed by a lawyer"]) {
      expect(text).toContain(part)
    }
  })

  test("SKILL-12: it never invents a number and never calls an agent compliant", () => {
    const text = plain(section(read(SKILL), "The personal data round"))
    expect(text).toContain("never write a number the builder did not give")
    expect(text).toContain("never say")
    expect(text).toContain("compliant")
  })
})
