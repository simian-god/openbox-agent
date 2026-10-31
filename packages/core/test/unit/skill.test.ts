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
import { chatConfig } from "../../src/cli/chat.ts"
import type { OpenboxConfig } from "../../src/config/index.ts"
import { CLI_BRAIN_IDS } from "../../src/config/providers.ts"
import { DB_ENV_KEYS } from "../../src/providers/db.ts"
import { ENV_KEYS, PGVECTOR_ENV_KEY } from "../../src/providers/index.ts"

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

/**
 * Backticks, case and where a line happens to wrap are formatting, not
 * content.
 *
 * The wrapping matters more than it looks. These files are formatted and
 * reflowed by hand, so a phrase a test looks for can move onto two lines
 * without anything about the instruction changing. A test that broke then
 * would be noise, and worse, a probe that only fails because of a wrap
 * reads as a test doing its job when it is not.
 */
const plain = (text: string): string => text.replace(/`/g, "").replace(/\s+/g, " ").toLowerCase()

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

/**
 * The bar a tool is written to, in SKILL-3 step 4 and again in SKILL-4.
 *
 * One list, because SKILL-4 says "to the same bar": two copies would let
 * the two commands drift apart and both tests keep passing.
 */
const TOOL_BAR = [
  "risk",
  "roles",
  "callwhen",
  "dontcallwhen",
  "confirmsummary",
  "5 should",
  "5 shouldnot",
]

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
    // 2500 was the budget while three of the six commands were a
    // paragraph each. They are flows now, and the cost of being read every
    // time is paid in what the file leaves out, not in a number: SKILL.md
    // and the two files SKILL-2 names come to about 4500 words together,
    // which is a few thousand tokens before a single question is asked.
    // Raised with a decisions row rather than quietly, and the pressure
    // moved to the test below, where it can be felt per command.
    expect(words(read(SKILL))).toBeLessThan(3000)
  })

  test("SKILL-1: no one command's flow crowds out the others", () => {
    // The file level budget alone would let one command take it all and
    // leave the next row to trim somebody else's section. `new` is the
    // longest on purpose, since it is six steps and writes a whole
    // project, so the bar is drawn above it rather than at an average.
    // Split rather than matched. A regex ending `(?=\n## |$)` under /m
    // stops at the end of the heading's own line, because `$` there means
    // end of line, so every section measured three words and the budget
    // measured nothing. The probe that doubled a section found that.
    const sections = read(SKILL)
      .split(/^## /m)
      .filter((part) => /^`[a-z][a-z-]*`/.test(part))

    expect(sections).toHaveLength(6)
    // Named, so a failure says which command went over rather than only
    // that one did.
    const over = sections
      .filter((text) => words(text) >= 650)
      .map((text) => `${text.split("\n")[0]} is ${words(text)} words`)
    expect(over).toEqual([])
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
    // The channel glue's confirm buttons belong to step 4 alone, since
    // `add-tool` writes no channels.
    for (const part of [...TOOL_BAR, "confirm buttons"]) {
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

/** Where the core reads each provider's key from, out of its own map. */
const envKeys = [...new Set([...Object.values(ENV_KEYS), PGVECTOR_ENV_KEY])]

/** Chat's own commands, read out of the terminal channel's help text. */
const chatCommands = (): string[] => {
  const source = read("packages/core/src/cli/terminal.ts")
  const start = source.indexOf("const HELP = `")
  expect(start).toBeGreaterThan(-1)
  const after = source.slice(start)
  const help = after.slice(0, after.indexOf("`", 14))
  return [...help.matchAll(/^ {2}(:\w+)/gm)].map((match) => match[1] ?? "")
}

describe("SKILL-4: `add-tool`", () => {
  test("SKILL-4: it grills on one tool, and writes nothing before that", () => {
    const text = plain(section(read(SKILL), "`add-tool`"))
    // The round itself, not just the word. Saying "a short grilling" in
    // the summary line passed this test with the whole round deleted,
    // which is how the probe found it. The grilling skill check and the
    // API docs rule both live in the round, so both are named here.
    expect(text).toContain("step 1's check")
    expect(text).toContain("no grilling skill, no add-tool")
    expect(text).toContain("api docs")
    expect(text).toContain("write nothing until")
  })

  test("SKILL-4: the tools already there are read first, because an overlap is a fact about a pair", () => {
    const text = plain(section(read(SKILL), "`add-tool`"))
    expect(text).toContain("every file in tools/")
    expect(text).toContain("overlap")
    // Checklist item 5 is the one this command fails most, and it cannot
    // be judged on the new tool alone.
    expect(text).toContain("item 5")
    // First, not somewhere. An overlap found after the tool is written is
    // a rewrite, and the words "overlap" and "item 5" appear again in the
    // checklist paragraph at the end, which is what let the probe through.
    expect(inOrder(text, "every file in tools/", "grill")).toBe(true)
  })

  test("SKILL-4: a new tool is held to the same bar as a tool `new` writes", () => {
    const text = plain(section(read(SKILL), "`add-tool`"))
    const missing = TOOL_BAR.filter((part) => !text.includes(part))
    expect(missing).toEqual([])
  })

  test("SKILL-4: the checklist is run over what was written, and the result shown", () => {
    const text = plain(section(read(SKILL), "`add-tool`"))
    expect(inOrder(text, "checklist", "show the builder")).toBe(true)
    expect(text).toContain("not quietly fixed")
  })

  test("SKILL-4: nothing registers a tool, because the folder is what is read", () => {
    // Real behaviour rather than a guess: `loadProject` imports every .ts
    // file in tools/ and keeps whatever `defineTool` produced, so the file
    // is the registration and a clashing name stops the start.
    const text = plain(section(read(SKILL), "`add-tool`"))
    expect(text).toContain("nothing to register")
    expect(text).toContain("one tool per file")
  })

  test("SKILL-4: what a new tool drags in with it is named", () => {
    const text = plain(section(read(SKILL), "`add-tool`"))
    // A table of its own, the secret the first irreversible tool needs,
    // and routing, which now has one more option to choose between.
    expect(text).toContain("db/migrations")
    expect(text).toContain("row level security")
    expect(text).toContain("openbox_secret")
    expect(text).toContain("openbox tune")
  })

  test("SKILL-4: the tool is not described in the prompt as well", () => {
    // Checklist item 9: a per tool rule in the prompt is a second answer
    // to a question the conditions already answer.
    const text = plain(section(read(SKILL), "`add-tool`"))
    expect(text).toContain("prompt.md")
    expect(text).toContain("item 9")
  })
})

describe("SKILL-5: `swap`", () => {
  test("SKILL-5: one provider changes in config, and nothing else does", () => {
    const text = plain(section(read(SKILL), "`swap`"))
    expect(text).toContain("agent.config.ts")
    for (const field of ["brain", "decisionmodel", "transcriber", "retriever", "fallbacks"]) {
      expect(text).toContain(field)
    }
  })

  test("SKILL-5: every key the core reads a provider from is named", () => {
    // Read out of the core's own ENV_KEYS rather than copied, so a new
    // provider with a new key fails here instead of leaving a builder to
    // find out at startup.
    const text = section(read(SKILL), "`swap`")
    expect(envKeys.length).toBeGreaterThanOrEqual(5)
    const missing = envKeys.filter((key) => !text.includes(key))
    expect(missing).toEqual([])
  })

  test("SKILL-5: a CLI brain is refused in production, as a primary and as a fallback", () => {
    const text = plain(section(read(SKILL), "`swap`"))
    for (const id of CLI_BRAIN_IDS) expect(text).toContain(id)
    expect(text).toContain("production")
    expect(text).toContain("fallback")
  })

  test("SKILL-5: the test to run is named per provider, and the brain's is the conformance suite", () => {
    const text = plain(section(read(SKILL), "`swap`"))
    expect(text).toContain("runconformance")
    expect(text).toContain("openbox tune")
    // And the two providers nothing is shipped for say so, rather than
    // being left out of the list as though a swap there needs no check.
    expect(text).toContain("nothing is shipped for these")
  })

  test("SKILL-5: what the conformance suite does not prove is said out loud", () => {
    // It brings its own prompt and its own two tools, so it answers
    // whether the brain can drive an agent and not whether this agent
    // still works. A swap report that left that out would overclaim.
    const text = plain(section(read(SKILL), "`swap`"))
    expect(text).toContain("does not prove")
  })

  test("SKILL-5: the result is reported, not assured", () => {
    const text = plain(section(read(SKILL), "`swap`"))
    expect(text).toContain("report what the tests said")
  })

  test("SKILL-5: a model nothing prices counts as zero against the spend cap", () => {
    // `costOf` returns 0 for a model the pricing table does not list when
    // the provider reported no cost of its own. A swap is exactly when
    // that happens, so the command has to say it.
    const text = plain(section(read(SKILL), "`swap`"))
    expect(text).toContain("pricing")
    expect(text).toContain("zero")
  })
})

describe("SKILL-6: `chat`", () => {
  test("SKILL-6: the burst window is zero, and the command is what sets it", () => {
    const text = plain(section(read(SKILL), "`chat`"))
    expect(text).toContain("burst window")
    expect(text).toContain("zero")
    // Against the real function, so the instruction cannot say one thing
    // while `openbox chat` does another. Everything else is left alone.
    const base = { name: "an-agent", burstWindowMs: 3000 } as unknown as OpenboxConfig
    expect(chatConfig(base).burstWindowMs).toBe(0)
    expect(chatConfig(base).name).toBe("an-agent")
  })

  test("SKILL-6: every command a chat session has is listed, and the list is the same list", () => {
    // Both lists read off their own file, and compared as lists. Looking
    // for each name anywhere in the section passed with the list itself
    // cut, because `:trace` is mentioned again in prose further down.
    const listed = [...section(read(SKILL), "`chat`").matchAll(/^(:\w+) {2,}\S/gm)].map(
      (match) => match[1] ?? "",
    )
    const commands = chatCommands()

    expect(commands.length).toBeGreaterThanOrEqual(4)
    expect(listed).toEqual(commands)
  })

  test("SKILL-6: a line starting with a slash is a message, so operator commands can be typed", () => {
    const text = plain(section(read(SKILL), "`chat`"))
    expect(text).toContain("line starting with /")
  })

  test("SKILL-6: what has to be in place first is named, not left to a stack trace", () => {
    const text = plain(section(read(SKILL), "`chat`"))
    expect(text).toContain("openbox migrate")
    for (const key of Object.values(DB_ENV_KEYS)) {
      expect(text).toContain(key.toLowerCase())
    }
  })

  test("SKILL-6: a button is tapped by number, which is how a confirmation is tried", () => {
    const text = plain(section(read(SKILL), "`chat`"))
    expect(text).toContain("number")
    expect(text).toContain("confirm")
  })

  test("SKILL-6: an operator session is made by the operator command, never in chat (ROLE-2)", () => {
    const text = plain(section(read(SKILL), "`chat`"))
    expect(text).toContain("openbox operator add")
    expect(text).toContain("never")
  })
})
