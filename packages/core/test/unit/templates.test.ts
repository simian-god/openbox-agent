// The templates the skill writes an agent project from (PKG-3), and the
// one rule a migration cannot be written without (DATA-5).
//
// These are files, so the tests are about the files: that each one is
// where the project layout puts it, that they parse as TypeScript, that
// every hole is marked one way, that nothing is imported an agent is not
// allowed to import, and that a template left unfilled refuses to start
// rather than running on numbers nobody chose.
//
// They are deliberately not typechecked by `tsc`: a template imports
// `./channels/...`, which the skill writes at T10.4 and which does not
// exist beside the template. So parsing is proven here instead, and the
// rest rests on the one thing a template can be held to without a project
// around it: what it says.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { MAX_PAYLOAD_BYTES } from "../../src/runtime/confirm.ts"

const root = join(import.meta.dir, "..", "..", "..", "..")
const read = (path: string): string => readFileSync(join(root, path), "utf8")

const DIR = "skill/templates"
const CONFIG = `${DIR}/agent.config.ts`
const TOOL = `${DIR}/tools/tool.ts`
const MIGRATION = `${DIR}/db/migrations/0001_agent.sql`
const SEED = `${DIR}/db/seed.ts`
const MAIN = `${DIR}/main.ts`

/** SKILL-10's four, plus the terminal the `chat` command uses. */
const CHANNELS = {
  whatsapp: `${DIR}/channels/whatsapp.ts`,
  telegram: `${DIR}/channels/telegram.ts`,
  discord: `${DIR}/channels/discord.ts`,
  web: `${DIR}/channels/web.ts`,
  terminal: `${DIR}/channels/terminal.ts`,
}

const TYPESCRIPT = [CONFIG, TOOL, SEED, MAIN, ...Object.values(CHANNELS)]

describe("PKG-3: the templates a project is written from", () => {
  test("PKG-3: each template is at the path the project layout puts it", () => {
    // The five this row owns. prompt.md is T10.1's template, the channel
    // glue is T10.4, and knowledge files and routing examples are content
    // rather than templates.
    for (const path of [CONFIG, TOOL, MIGRATION, SEED, MAIN]) {
      expect(existsSync(join(root, path))).toBe(true)
    }
  })

  test("PKG-3: every TypeScript template parses, so nothing ships broken", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    for (const path of TYPESCRIPT) {
      expect(() => transpiler.transformSync(read(path))).not.toThrow()
    }
  })

  test("PKG-3: every hole is written the one way, and sits in a comment", () => {
    // Same `{{snake_case}}` as the prompt template, so one search finds
    // every unfilled hole in a project.
    //
    // In a comment rather than in the code, which is what makes these
    // templates different from the prompt template: a hole in an
    // identifier would not parse, and a hole in a value would either not
    // parse or quietly start. So the code carries a sample the skill
    // renames, and the comment carries the hole. The migration follows
    // the same rule for the same reason: a table name is an identifier,
    // and a template migration that cannot be applied is a template
    // nobody can check.
    // Every project template has at least one hole, because every one of
    // them says something only the builder knows. A channel glue is not
    // held to that: most of a glue is the channel's own rules, and
    // Telegram's has nothing in it for a builder to fill. What every
    // template is held to is the form, so a hole that is there is one
    // search away.
    for (const path of [CONFIG, TOOL, MIGRATION, SEED, MAIN]) {
      expect(read(path)).toMatch(/\{\{[a-z][a-z0-9_]*\}\}/)
    }

    for (const path of [...TYPESCRIPT, MIGRATION]) {
      const text = read(path)
      for (const line of text.split("\n")) {
        if (!line.includes("{{")) continue
        const marker = line.search(/\/\/|--|\*/)
        expect(marker).toBeGreaterThanOrEqual(0)
        expect(marker).toBeLessThan(line.indexOf("{{"))
      }
      expect(text.split("{{").length).toBe(text.split("}}").length)
    }
  })

  test("PKG-1: a template imports nothing an agent may not import", () => {
    // PKG-1: an agent imports the core through its one public entry. The
    // only other things allowed are zod, the project's own files and node
    // builtins.
    for (const path of TYPESCRIPT) {
      const imports = [...read(path).matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? "")
      const wrong = imports.filter(
        (from) =>
          from !== "openbox-agent" &&
          from !== "zod" &&
          !from.startsWith("./") &&
          !from.startsWith("../") &&
          !from.startsWith("node:"),
      )
      expect(wrong).toEqual([])
    }
  })
})

describe("PKG-3: the config template", () => {
  test("PKG-3: it names every field config requires and has no default for", () => {
    const text = read(CONFIG)
    for (const field of ["notice", "retentionDays", "dailySpendUsd", "name", "timezone"]) {
      expect(text).toContain(field)
    }
  })

  test("CFG-1: unfilled, it refuses to start and names what is missing", async () => {
    // The point of the sentinels. A template cannot hold a hole where a
    // number goes, so it holds a value that cannot pass validation: the
    // skill fills them from the builder's own answers, and a project that
    // reached production unfilled stops at startup instead of keeping
    // somebody's data for a year nobody agreed to.
    const url = Bun.pathToFileURL(join(root, CONFIG)).href
    const failure = await import(url).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeDefined()
    const said = failure instanceof Error ? failure.message : String(failure)
    expect(said).toContain("retentionDays")
    expect(said).toContain("notice")
    expect(said).toContain("dailySpendUsd")
  })
})

describe("DATA-5: the migration template", () => {
  test("DATA-5: every table it creates has row level security switched on", () => {
    const sql = read(MIGRATION).toLowerCase()
    const created = [...sql.matchAll(/create table (?:if not exists )?([a-z0-9_]+)/g)].map(
      (match) => match[1] ?? "",
    )
    expect(created.length).toBeGreaterThan(0)
    for (const table of created) {
      expect(sql).toContain(`alter table ${table} enable row level security`)
    }
  })

  test("DATA-5: and it says why, because the migrate command refuses without it", () => {
    expect(read(MIGRATION).toLowerCase()).toContain("row level security")
    expect(read(MIGRATION)).toContain("DATA-5")
  })

  test("DATA-1: its rows carry the agent they belong to", () => {
    expect(read(MIGRATION).toLowerCase()).toContain("agent_id")
  })
})

describe("PKG-3: the seed and main.ts", () => {
  test("PKG-3: the seed is scoped to this agent and can be run twice", () => {
    const text = read(SEED)
    expect(text).toContain("createStore")
    // ROLE-2: the first operator, and nobody is created twice.
    expect(text).toContain('role: "operator"')
    expect(text).toMatch(/find\(/)
  })

  test("PKG-3: main.ts builds the providers, the database and the channel, then starts", () => {
    const text = read(MAIN)
    for (const part of [
      "providersFromConfig",
      "supabaseFromEnv",
      "createAgent",
      "agent.start()",
      "agent.stop()",
    ]) {
      expect(text).toContain(part)
    }
  })

  test("PKG-3: and gives up its leases when the process is told to stop", () => {
    // LOOP-2 and DATA-4: a process that exits without stopping leaves a
    // person leased until it expires, which is a delay nobody can see the
    // reason for.
    const text = read(MAIN)
    expect(text).toContain("SIGTERM")
    expect(text).toContain("SIGINT")
  })
})

describe("PKG-3: the tool template", () => {
  test("PKG-3: it carries every part TOOL-2 refuses a tool without", () => {
    const text = read(TOOL)
    for (const part of [
      "defineTool",
      "risk:",
      "roles:",
      "callWhen",
      "dontCallWhen",
      "input:",
      "handler",
    ]) {
      expect(text).toContain(part)
    }
  })

  test("PKG-3: with the five examples each way that registration needs", () => {
    const text = read(TOOL)
    const list = (name: string): string[] => {
      const start = text.indexOf(`${name}: [`)
      expect(start).toBeGreaterThan(-1)
      const body = text.slice(start, text.indexOf("]", start))
      return [...body.matchAll(/"[^"]+"/g)].map((match) => match[0])
    }
    expect(list("should").length).toBeGreaterThanOrEqual(5)
    expect(list("shouldNot").length).toBeGreaterThanOrEqual(5)
  })

  test("CONF-2: and says what an irreversible tool has to add", () => {
    // A `confirmSummary` is what the person reads before tapping Confirm,
    // so a template that left it out would be a template for the one kind
    // of tool that cannot be got wrong quietly.
    expect(read(TOOL)).toContain("confirmSummary")
  })
})

describe("SKILL-10: the channel glue", () => {
  test("SKILL-10: every channel the Spec names has a template", () => {
    // WhatsApp Cloud API, Telegram Bot API, Discord and a generic web
    // webhook are SKILL-10's four. The terminal is here as well because
    // SKILL-6's `chat` needs one and a builder should not have to write
    // the first channel to see their agent answer.
    for (const path of Object.values(CHANNELS)) {
      expect(existsSync(join(root, path))).toBe(true)
    }
  })

  test("SKILL-10: each one exports the sender and the serve main.ts calls", () => {
    for (const path of Object.values(CHANNELS)) {
      const text = read(path)
      expect(text).toMatch(/export default \{/)
      expect(text).toContain("sender")
      expect(text).toContain("serve")
    }
  })

  test("SKILL-10: each names itself the way config and `operator add` name it", () => {
    // The channel string is how a person is found again and how an
    // operator is added, so a glue that called itself something else
    // would make a second person out of the same one.
    //
    // Read off the one constant each glue uses, not from anywhere in the
    // file: WhatsApp's own send body carries the word "whatsapp" in a
    // field of Meta's, which is what made the first version of this test
    // pass with the channel renamed.
    for (const [name, path] of Object.entries(CHANNELS)) {
      const declared = /const CHANNEL = "([a-z]+)"/.exec(read(path))?.[1]
      expect(declared).toBe(name)
    }
  })

  test("SKILL-10: capabilities are answered in full, honestly", () => {
    for (const path of Object.values(CHANNELS)) {
      const text = read(path)
      if (path === CHANNELS.terminal) continue
      expect(text).toContain("capabilities")
      for (const field of ["buttons", "files", "templates", "idempotentSends"]) {
        expect(text).toContain(field)
      }
    }
  })

  test("PRO-3: WhatsApp says its window is 24 hours, which is what the core needs", () => {
    // Read off Meta's own docs: inside the window any message may be
    // sent, outside it only an approved template. PRO-3 is the rule that
    // depends on this number being here.
    expect(read(CHANNELS.whatsapp)).toContain("windowHours: 24")
  })

  test("CONF-7: a glue renders the payload it was handed and never makes one", () => {
    // The confirm logic is the core's. A glue that built or read a
    // payload would be the second place a signature is decided, which is
    // the one thing CONF-7 says not to do.
    for (const path of Object.values(CHANNELS)) {
      const text = read(path)
      expect(text).not.toContain("buttonPayload")
      expect(text).not.toContain("parsePayload")
      expect(text).not.toContain("OPENBOX_SECRET")
    }
  })

  test("CONF-7: a tap comes back as the action payload, untouched", () => {
    for (const [name, path] of Object.entries(CHANNELS)) {
      if (name === "terminal") continue
      expect(read(path)).toMatch(/action: \{ payload/)
    }
  })

  test("CONF-3: the Telegram button carries the payload in the 64 bytes it has", () => {
    const text = read(CHANNELS.telegram)
    expect(text).toContain("callback_data")
    // The number itself, read off the glue's own constant and compared
    // with the core's. Two copies of a limit that drift apart is how a
    // button starts failing in production, and `toContain("64")` was
    // happy with 640.
    const declared = /CALLBACK_DATA_BYTES = (\d+)/.exec(text)?.[1]
    expect(Number(declared)).toBe(MAX_PAYLOAD_BYTES)
    // And the acknowledgement Telegram asks for, or the client spins.
    expect(text).toContain("answerCallbackQuery")
  })

  test("SKILL-10: WhatsApp reads both of the two shapes a tap arrives in", () => {
    // Meta's docs: a free-form interactive button comes back as
    // `interactive.button_reply`, and the same button on a template comes
    // back as `button.payload`. A glue that read only the first would
    // silently drop every confirm sent outside the window.
    const text = read(CHANNELS.whatsapp)
    expect(text).toContain("button_reply")
    expect(text).toContain("payload")
  })

  test("SKILL-10: every webhook checks the request came from the channel", () => {
    // Each channel's own documented mechanism, not a shared guess.
    expect(read(CHANNELS.whatsapp)).toContain("X-Hub-Signature-256")
    expect(read(CHANNELS.telegram)).toContain("X-Telegram-Bot-Api-Secret-Token")
    expect(read(CHANNELS.discord)).toContain("X-Signature-Ed25519")
    expect(read(CHANNELS.web)).toMatch(/secret|signature/i)
  })

  test("SEND-1: a send says what happened, so the outbox knows what to do", () => {
    for (const [name, path] of Object.entries(CHANNELS)) {
      if (name === "terminal") continue
      const text = read(path)
      expect(text).toContain('status: "sent"')
      expect(text).toContain('status: "rejected"')
      expect(text).toContain("retryable")
    }
  })

  test("SKILL-6: the terminal template is the core's own channel, not a second one", () => {
    // The core ships a terminal channel and `openbox chat` uses it. A
    // second implementation here would be a second thing to keep in step.
    const text = read(CHANNELS.terminal)
    expect(text).toContain("terminalChannel")
    expect(text).toContain("burstWindowMs")
  })
})
