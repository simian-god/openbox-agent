// LEARN-4 against a real database: the backlog, the conversation behind a
// flag, and marking one reviewed exactly once.
//
// The grouping arithmetic is a unit test. What needs Postgres is
// everything that rests on a query being right: that an unreviewed flag is
// one with no `reviewed_at`, that a conversation is read in the order it
// happened, that one agent never sees another's flags (DATA-1), and that
// two reviewers marking the same flag do not both think they got it
// (DATA-4).
//
// One test runs a real turn rather than inserting rows, because the
// claim that matters most is that a flag the core raised by itself can be
// read back with the conversation that caused it.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { fakeIo } from "../support/chat.ts"
import { runReview } from "../../src/cli/review.ts"
import { trackAgents } from "../support/agents.ts"
import type { Agent } from "../../src/runtime/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool } from "../../src/tools/index.ts"
import { scriptedBrain, type ScriptedStep } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel } from "../../src/testing/scripted-decision.ts"
import { fakeSender } from "../../src/testing/fake-sender.ts"
import {
  flaggedConversation,
  markReviewed,
  reviewBacklog,
  unreviewedFlags,
} from "../../src/review/index.ts"
import { createStore } from "../../src/store/index.ts"

const agents = trackAgents("review.test.ts")

const hours = defineTool({
  name: "opening_hours",
  description: "What time the restaurant opens.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask about hours"], dontCallWhen: ["they do not"] },
  examples: { should: ["what time do you open?"], shouldNot: ["hello"] },
  handler: async () => {
    throw new Error("the hours service is down")
  },
})

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: [["11:00", "23:00"]] },
    brain: { id: "openrouter", model: "test/model" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages.",
    retentionDays: 365,
    burstWindowMs: 0,
    ...over,
  })
}

/** What the command loads off disk, written once for every test below. */
const CORE = pathToFileURL(join(import.meta.dir, "..", "..", "src", "index.ts")).href
const ZOD = import.meta.resolve("zod")

const PROJECT_CONFIG = `
export default {
  name: "restaurant",
  mode: "development",
  timezone: "Asia/Kolkata",
  hours: { mon: [["11:00", "23:00"]] },
  brain: { id: "openrouter", model: "test/model" },
  decisionModel: { id: "jev" },
  retriever: { id: "local" },
  limits: { dailySpendUsd: 5 },
  notice: "We store your messages.",
  retentionDays: 365,
}
`

const PROJECT_TOOL = `
import { defineTool } from ${JSON.stringify(CORE)}
import { z } from ${JSON.stringify(ZOD)}

export default defineTool({
  name: "opening_hours",
  description: "What time the restaurant opens.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask about hours"], dontCallWhen: ["they do not"] },
  examples: { should: ["what time do you open?"], shouldNot: ["hello"] },
  handler: async () => ({ ok: true }),
})
`

const EXISTING_LABEL = `{"text":"what time do you open?","tool":"opening_hours"}
`

describeDatabase("LEARN-4: the review backlog", (sql) => {
  beforeEach(async () => {
    await resetDatabase(sql())
  })

  function build(steps: ScriptedStep[] = [{ reply: "Hello." }], over = {}): Agent {
    return agents.create({
      config: config(over),
      deps: {
        brains: [scriptedBrain(steps)],
        decisionModel: scriptedDecisionModel([]),
        db: localSupabase(),
        sender: fakeSender(),
      },
      prompt: "You are the host at a restaurant.",
      tools: [hours],
    })
  }

  async function someone(agent: Agent, name: string): Promise<string> {
    const person = await agent.store.people.insert({
      channel: "whatsapp",
      channel_user_id: name,
      display_name: name,
    })
    return person.id
  }

  test("LEARN-4: the backlog is every flag nobody has reviewed, oldest first", async () => {
    const agent = build()
    const personId = await someone(agent, "asha")

    await agent.store.flags.insert({ person_id: personId, kind: "tool_error", detail: {} })
    await agent.store.flags.insert({ person_id: personId, kind: "gate_block", detail: {} })
    const done = await agent.store.flags.insert({
      person_id: personId,
      kind: "frustration",
      detail: {},
    })
    await markReviewed({ store: agent.store, flagIds: [done.id], outcome: "nothing to fix" })

    const waiting = await unreviewedFlags({ store: agent.store })

    expect(waiting.map((flag) => flag.kind)).toEqual(["tool_error", "gate_block"])
  })

  test("LEARN-4: the backlog comes back grouped by likely cause", async () => {
    const agent = build()
    const personId = await someone(agent, "asha")

    for (const kind of ["tool_error", "tool_error", "gate_block"] as const) {
      await agent.store.flags.insert({
        person_id: personId,
        kind,
        detail: { tool: "opening_hours" },
      })
    }

    const groups = await reviewBacklog({ store: agent.store })

    expect(groups.map((group) => group.cause)).toEqual(["tool bug", "conditions too strict"])
    expect(groups[0]?.conversations).toHaveLength(2)
  })

  test("LEARN-4: a real tool failure comes back with the conversation that caused it", async () => {
    // The whole point of the command: a flag the core raised by itself,
    // read back with what the person said and what the tool did.
    const agent = build([{ tool: "opening_hours", input: {} }, { reply: "Sorry, I cannot check." }])
    agent.start()

    await agent.receiveAndWait({
      channel: "whatsapp",
      channelUserId: "asha",
      channelMessageId: "m1",
      text: "what time do you open?",
    })

    const [flag] = await unreviewedFlags({ store: agent.store })
    expect(flag?.kind).toBe("tool_error")

    const conversation = await flaggedConversation(agent.store, flag!)

    expect(conversation.cause).toBe("tool bug")
    expect(conversation.why).toContain("opening_hours")
    expect(conversation.person?.channel_user_id).toBe("asha")
    expect(conversation.turn?.id).toBe(flag?.turn_id ?? undefined)
    expect(conversation.messages.map((message) => message.text ?? "")).toContain(
      "what time do you open?",
    )
    expect(conversation.toolRuns.map((run) => run.tool)).toEqual(["opening_hours"])
    expect(conversation.toolRuns[0]?.status).not.toBe("ok")
  })

  test("LEARN-4: a conversation reads oldest first, however long it has been going", async () => {
    const agent = build()
    const personId = await someone(agent, "asha")

    for (const text of ["one", "two", "three"]) {
      await agent.store.messages.insert({
        person_id: personId,
        turn_id: null,
        direction: "inbound",
        author: "person",
        text,
        channel: "whatsapp",
      })
    }
    const flag = await agent.store.flags.insert({
      person_id: personId,
      kind: "frustration",
      detail: {},
    })

    // A window of two keeps the newest two, in the order they were said.
    const conversation = await flaggedConversation(agent.store, flag, { messageWindow: 2 })

    expect(conversation.messages.map((message) => message.text)).toEqual(["two", "three"])
  })

  test("LEARN-4: every other flag on the same turn is named", async () => {
    // One fault usually raises several, and a reviewer fixing them one at
    // a time is doing the same work three times.
    const agent = build()
    const personId = await someone(agent, "asha")
    const turn = await agent.store.turns.insert({
      person_id: personId,
      version_id: null,
      brains: [],
      steps: 1,
      cost_usd: 0,
      started_at: new Date().toISOString(),
    })

    const first = await agent.store.flags.insert({
      person_id: personId,
      turn_id: turn.id,
      kind: "tool_error",
      detail: {},
    })
    await agent.store.flags.insert({
      person_id: personId,
      turn_id: turn.id,
      kind: "handover",
      detail: { reason: "tool_failed_repeat" },
    })

    const conversation = await flaggedConversation(agent.store, first)

    expect(conversation.alsoFlagged).toEqual(["handover"])
  })

  test("LEARN-4: marking a flag reviewed records the outcome and clears the backlog", async () => {
    const agent = build()
    const personId = await someone(agent, "asha")
    const flag = await agent.store.flags.insert({
      person_id: personId,
      kind: "tool_error",
      detail: {},
    })

    const marked = await markReviewed({
      store: agent.store,
      flagIds: [flag.id],
      outcome: "fixed in the tool, case added",
    })

    expect(marked).toHaveLength(1)
    expect(marked[0]?.review_outcome).toBe("fixed in the tool, case added")
    expect(marked[0]?.reviewed_at).not.toBeNull()
    expect(await unreviewedFlags({ store: agent.store })).toEqual([])
  })

  test("LEARN-4: a flag already reviewed keeps the first outcome, and the second review is told", async () => {
    // DATA-4's conditional claim. Two reviewers on one backlog would
    // otherwise each write over the other, and the loser would think
    // their decision was the one on record.
    const agent = build()
    const personId = await someone(agent, "asha")
    const flag = await agent.store.flags.insert({
      person_id: personId,
      kind: "tool_error",
      detail: {},
    })

    await markReviewed({ store: agent.store, flagIds: [flag.id], outcome: "first" })
    const second = await markReviewed({ store: agent.store, flagIds: [flag.id], outcome: "second" })

    expect(second).toEqual([])
    expect((await agent.store.flags.byId(flag.id))?.review_outcome).toBe("first")
  })

  test("LEARN-4: an outcome is required, because step 7 is what came of it", async () => {
    const agent = build()
    expect(() => markReviewed({ store: agent.store, flagIds: ["x"], outcome: "  " })).toThrow(
      /outcome/,
    )
  })

  test("LEARN-4: one agent never reviews another agent's flags", async () => {
    // DATA-1. Two agents on one database is the normal case, and a review
    // that reached across would show somebody else's conversations.
    const agent = build()
    const personId = await someone(agent, "asha")
    const flag = await agent.store.flags.insert({
      person_id: personId,
      kind: "tool_error",
      detail: {},
    })

    const other = createStore(localSupabase(), "another-agent")

    expect(await unreviewedFlags({ store: other })).toEqual([])
    expect(await markReviewed({ store: other, flagIds: [flag.id], outcome: "mine now" })).toEqual(
      [],
    )
    expect((await agent.store.flags.byId(flag.id))?.reviewed_at).toBeNull()
  })
})

describeDatabase("LEARN-4 and LEARN-5: the openbox review command", (sql) => {
  const made: string[] = []

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A project on disk, so the command loads a real agent (PKG-3). */
  function project(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "openbox-review-"))
    made.push(dir)
    const base: Record<string, string> = {
      "agent.config.ts": PROJECT_CONFIG,
      "prompt.md": "# Identity and goal\nYou are the host.",
      "tools/hours.ts": PROJECT_TOOL,
    }
    for (const [name, body] of Object.entries({ ...base, ...files })) {
      const path = join(dir, name)
      mkdirSync(join(path, ".."), { recursive: true })
      writeFileSync(path, body, "utf8")
    }
    return dir
  }

  /** A person, a turn, a message and a flag, written straight in. */
  async function flagged(kind = "tool_error", detail: Record<string, unknown> = {}) {
    const store = createStore(localSupabase(), "restaurant")
    const person = await store.people.insert({
      channel: "whatsapp",
      channel_user_id: "asha",
      display_name: "Asha",
    })
    const turn = await store.turns.insert({
      person_id: person.id,
      version_id: null,
      brains: [],
      steps: 1,
      cost_usd: 0,
      started_at: new Date().toISOString(),
    })
    await store.messages.insert({
      person_id: person.id,
      turn_id: turn.id,
      direction: "inbound",
      author: "person",
      text: "what time do you open?",
      channel: "whatsapp",
    })
    const flag = await store.flags.insert({
      person_id: person.id,
      turn_id: turn.id,
      kind,
      detail,
    })
    return { store, flag, person }
  }

  test("LEARN-4: list prints the backlog grouped by cause, with each flag's id", async () => {
    const { store, flag } = await flagged("tool_error", { tool: "opening_hours", error: "503" })
    const io = fakeIo()

    const code = await runReview({ dir: project(), io, store, args: ["list"] })

    expect(code).toBe(0)
    expect(io.text()).toContain("tool bug (1)")
    expect(io.text()).toContain(flag.id)
    expect(io.text()).toContain("503")
  })

  test("LEARN-4: an empty backlog says so rather than printing a heading", async () => {
    const store = createStore(localSupabase(), "restaurant")
    const io = fakeIo()

    expect(await runReview({ dir: project(), io, store, args: ["list"] })).toBe(0)
    expect(io.text()).toContain("Nothing to review")
  })

  test("LEARN-4: --json is the same backlog, for the reader that is an agent", async () => {
    const { store } = await flagged("gate_block", { tool: "opening_hours" })
    const io = fakeIo()

    await runReview({ dir: project(), io, store, args: ["list"], json: true })
    const groups = JSON.parse(io.text()) as { cause: string; conversations: unknown[] }[]

    expect(groups[0]?.cause).toBe("conditions too strict")
    expect(groups[0]?.conversations).toHaveLength(1)
  })

  test("LEARN-4: show prints the conversation, the tools and the cause", async () => {
    const { store, flag } = await flagged("tool_error", { tool: "opening_hours", error: "503" })
    const io = fakeIo()

    expect(await runReview({ dir: project(), io, store, args: ["show", flag.id] })).toBe(0)
    expect(io.text()).toContain("what time do you open?")
    expect(io.text()).toContain("cause tool bug")
  })

  test("LEARN-4: a flag id nothing matches is said plainly", async () => {
    const store = createStore(localSupabase(), "restaurant")
    const io = fakeIo()

    const code = await runReview({
      dir: project(),
      io,
      store,
      args: ["show", "11111111-2222-3333-4444-555555555555"],
    })

    expect(code).toBe(1)
    expect(io.text()).toContain("No flag")
  })

  test("LEARN-4: mark records the outcome, and says what it could not mark", async () => {
    const { store, flag } = await flagged()
    const io = fakeIo()

    const first = await runReview({
      dir: project(),
      io,
      store,
      args: ["mark", flag.id],
      outcome: "fixed the tool",
    })
    expect(first).toBe(0)
    expect((await store.flags.byId(flag.id))?.review_outcome).toBe("fixed the tool")

    // Again, which is the case a second reviewer has to be told about
    // rather than left to assume.
    const again = fakeIo()
    const second = await runReview({
      dir: project(),
      io: again,
      store,
      args: ["mark", flag.id],
      outcome: "mine",
    })
    expect(second).toBe(1)
    expect(again.text()).toContain("Already reviewed")
    expect((await store.flags.byId(flag.id))?.review_outcome).toBe("fixed the tool")
  })

  test("LEARN-4: mark without an outcome refuses, because step 7 is the outcome", async () => {
    const { store, flag } = await flagged()
    const io = fakeIo()

    expect(await runReview({ dir: project(), io, store, args: ["mark", flag.id] })).toBe(1)
    expect(io.text()).toContain("--outcome")
    expect((await store.flags.byId(flag.id))?.reviewed_at).toBeNull()
  })

  test("LEARN-5: label appends the corrected routing decision to the labeled set", async () => {
    const { store, flag } = await flagged("low_confidence", { choice: "no_tool" })
    const dir = project()
    const io = fakeIo()

    const code = await runReview({
      dir,
      io,
      store,
      args: ["label", flag.id],
      tool: "opening_hours",
    })

    expect(code).toBe(0)
    const written = readFileSync(join(dir, "examples", "routing.jsonl"), "utf8")
    expect(JSON.parse(written.trim())).toEqual({
      text: "what time do you open?",
      tool: "opening_hours",
    })
  })

  test("LEARN-5: the same conversation is not labeled twice", async () => {
    const { store, flag } = await flagged("low_confidence", { choice: "no_tool" })
    const dir = project({ "examples/routing.jsonl": EXISTING_LABEL })
    const io = fakeIo()

    const code = await runReview({ dir, io, store, args: ["label", flag.id], tool: "no_tool" })

    expect(code).toBe(1)
    expect(io.text()).toContain("already labels")
    expect(
      readFileSync(join(dir, "examples", "routing.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(1)
  })

  test("LEARN-5: a tool the agent does not have is refused, and nothing is written", async () => {
    const { store, flag } = await flagged("low_confidence", { choice: "no_tool" })
    const dir = project()
    const io = fakeIo()

    const code = await runReview({ dir, io, store, args: ["label", flag.id], tool: "cancel_table" })

    expect(code).toBe(1)
    expect(io.text()).toContain("cancel_table")
    expect(existsSync(join(dir, "examples", "routing.jsonl"))).toBe(false)
  })

  test("LEARN-7: nothing here writes to agent.config.ts", async () => {
    // The whole command reads. The one file it writes is the labeled set,
    // which is evidence rather than behaviour, and even that is one
    // subcommand the reviewer runs on purpose.
    const { store, flag } = await flagged("low_confidence", { choice: "no_tool" })
    const dir = project()
    const before = readFileSync(join(dir, "agent.config.ts"), "utf8")

    for (const args of [["list"], ["show", flag.id], ["label", flag.id]]) {
      await runReview({ dir, io: fakeIo(), store, args, tool: "opening_hours" })
    }
    await runReview({ dir, io: fakeIo(), store, args: ["mark", flag.id], outcome: "done" })

    expect(readFileSync(join(dir, "agent.config.ts"), "utf8")).toBe(before)
  })

  test("LEARN-4: an unknown subcommand prints the usage rather than guessing", async () => {
    const store = createStore(localSupabase(), "restaurant")
    const io = fakeIo()

    expect(await runReview({ dir: project(), io, store, args: ["delete"] })).toBe(1)
    expect(io.text()).toContain("openbox review")
  })

  test("LEARN-4: a folder with no agent in it says what is missing", async () => {
    const io = fakeIo()
    const empty = mkdtempSync(join(tmpdir(), "openbox-empty-"))
    made.push(empty)

    expect(await runReview({ dir: empty, io, args: ["list"] })).toBe(1)
    expect(io.text()).toContain("agent.config.ts")
  })
})
