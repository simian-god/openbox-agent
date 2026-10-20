// SKILL-6: `openbox chat` end to end, against Postgres and the demo agent.
//
// Everything is real except the brain and the terminal: a scripted brain so
// no key or network is needed (TEST-3), and a fake io so no tty is needed.
import { test, expect, beforeAll, beforeEach } from "bun:test"
import { join } from "node:path"
import { describe } from "bun:test"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { migrate } from "../../src/migrate/index.ts"
import { createAgent, type Deps } from "../../src/runtime/index.ts"
import { createStore } from "../../src/store/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import {
  scriptedBrain,
  type ScriptedBrain,
  type ScriptedStep,
} from "../../src/testing/scripted-brain.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import { terminalChannel, TERMINAL_CHANNEL } from "../../src/cli/terminal.ts"
import { fakeIo, type FakeIo } from "../support/chat.ts"
import { runChat } from "../../src/cli/chat.ts"
import { loadProject } from "../../src/cli/project.ts"

const DEMO = join(import.meta.dir, "..", "..", "..", "..", "examples", "demo-agent")

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "demo-restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: [["11:00", "23:00"]] },
    brain: { id: "openrouter", model: "test/model" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages.",
    retentionDays: 365,
    ...over,
  })
}

describeDatabase("openbox chat", (sql) => {
  const clock = fixedClock("2026-10-19T06:00:00Z")

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  /** A chat session over a real agent with a scripted brain. */
  async function chat(
    typed: string[],
    script: ScriptedStep[],
    over: Record<string, unknown> = {},
  ): Promise<{ io: FakeIo; brain: ScriptedBrain; agent: ReturnType<typeof createAgent> }> {
    const io = fakeIo(typed)
    const brain = scriptedBrain(script)
    const channel = terminalChannel({ io, sessionId: "s1" })
    const deps: Deps = { brains: [brain], db: localSupabase(), sender: channel.sender, clock }
    const agent = createAgent({
      config: config(over),
      deps,
      prompt: "You are the host.",
      tools: [],
    })

    await channel.run(agent)
    return { io, brain, agent }
  }

  test("SKILL-6: a typed line is answered, and the answer is printed", async () => {
    const { io } = await chat(["Are you open now?"], [{ reply: "We open at 11." }])

    expect(io.text()).toContain("demo-restaurant> We open at 11.")
  })

  test("SKILL-6: the session opens with the agent's name and how to leave", async () => {
    const { io } = await chat([], [])

    expect(io.text()).toContain("openbox chat - demo-restaurant")
    expect(io.text()).toContain(":quit")
  })

  test("SKILL-6: the conversation is stored, so a second line has history", async () => {
    const { brain } = await chat(
      ["Are you open now?", "And tomorrow?"],
      [{ reply: "We open at 11." }, { reply: "Same tomorrow." }],
    )

    expect(brain.calls[1]?.messages).toEqual([
      { role: "person", text: "Are you open now?" },
      { role: "agent", text: "We open at 11." },
      { role: "person", text: "And tomorrow?" },
    ])
  })

  test("ROLE-1: whoever is typing is created as an end user on the terminal channel", async () => {
    const { agent } = await chat(["hello"], [{ reply: "hi" }])

    const person = await agent.store.people.find({ channel: TERMINAL_CHANNEL })
    expect(person?.role).toBe("end_user")
    expect(person?.channel_user_id).toBe("local")
  })

  test("SKILL-6: :quit leaves, and nothing after it is sent", async () => {
    const { brain } = await chat([":quit", "this is never typed"], [{ reply: "one" }])

    expect(brain.calls).toHaveLength(0)
  })

  test("SKILL-6: a blank line sends nothing", async () => {
    const { brain } = await chat(["", "   ", "hello"], [{ reply: "hi" }])

    expect(brain.calls).toHaveLength(1)
  })

  test("SKILL-6: :version shows the version the agent is running", async () => {
    const { io, agent } = await chat([":version"], [])

    expect(io.text()).toContain(agent.versionHash)
  })

  test("SKILL-6: :trace shows what the turn recorded", async () => {
    const { io } = await chat(["hello", ":trace"], [{ reply: "hi" }])

    expect(io.text()).toContain("turn_started")
    expect(io.text()).toContain("turn_ended")
  })

  test("SKILL-6: :trace before anything happened says so", async () => {
    const { io } = await chat([":trace"], [])

    expect(io.text()).toContain("Nothing recorded yet")
  })

  test("SKILL-6: an unknown command is reported, not sent to the agent", async () => {
    const { io, brain } = await chat([":nope"], [{ reply: "hi" }])

    expect(io.text()).toContain("No command :nope")
    expect(brain.calls).toHaveLength(0)
  })

  test("SKILL-6: a line starting with a slash reaches the agent", async () => {
    // HAND's operator commands are messages. Chat must not swallow them.
    const { brain } = await chat(["/take"], [{ reply: "ok" }])

    expect(brain.calls[0]?.messages).toEqual([{ role: "person", text: "/take" }])
  })

  test("LOOP-1: two identical lines are two messages, not a duplicate", async () => {
    // Each typed line gets its own channel message id, so saying the same
    // thing twice is answered twice.
    const { brain } = await chat(["hello", "hello"], [{ reply: "one" }, { reply: "two" }])

    expect(brain.calls).toHaveLength(2)
  })

  test("SKILL-6: a button the agent offered is tapped by number, as its payload", async () => {
    const io = fakeIo(["1"])
    const brain = scriptedBrain([{ reply: "Booked." }])
    const channel = terminalChannel({ io, sessionId: "s1" })
    const agent = createAgent({
      config: config(),
      deps: { brains: [brain], db: localSupabase(), sender: channel.sender, clock },
      prompt: "You are the host.",
      tools: [],
    })

    // The core's confirm flow is M4, so the buttons are put on the wire
    // here the way CONF-3 will put them. What this proves is the terminal
    // half: a printed button typed back reaches the agent as its payload.
    await channel.sender.send({
      channel: TERMINAL_CHANNEL,
      channelUserId: "local",
      text: "Confirm the booking?",
      buttons: [
        { label: "Confirm", payload: "confirm:abc" },
        { label: "Cancel", payload: "cancel:abc" },
      ],
      idempotencyKey: "k",
    })
    await channel.run(agent)

    expect(io.text()).toContain("[1] Confirm")
    // The payload is passed through untouched (API-3's Inbound.action).
    const row = await agent.store.inbox.find({ channel_message_id: "s1-in-1" })
    expect(row?.action).toEqual({ payload: "confirm:abc" })
    // And the brain sees the label, which is what the person actually did.
    expect(brain.calls[0]?.messages).toEqual([{ role: "person", text: "Confirm" }])
  })
})

describeDatabase("openbox chat against the demo agent", (sql) => {
  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  test("SKILL-6: the demo agent loads from its own folder", async () => {
    const project = await loadProject({ dir: DEMO })

    expect(project.config.name).toBe("demo-restaurant")
    expect(project.prompt).toContain("Identity and goal")
    expect(project.tools.map((tool) => tool.name)).toEqual(["check_opening_hours"])
  })

  test("SKILL-6: runChat answers a question through the agent's one tool", async () => {
    const io = fakeIo(["are you open on Monday?"])
    const brain = scriptedBrain([
      { tool: "check_opening_hours", input: { day: "monday" } },
      { reply: "We are open 11:00 to 15:00 and 19:00 to 23:00 on Monday." },
    ])

    const code = await runChat({
      dir: DEMO,
      io,
      brains: [brain],
      db: localSupabase(),
      sessionId: "s1",
      env: {},
    })

    expect(code).toBe(0)
    expect(io.text()).toContain("1 tool loaded")
    expect(io.text()).toContain("11:00 to 15:00")

    // The tool really ran, and really read the config's hours.
    const result = brain.calls[1]?.messages.at(-1) as { result?: unknown }
    expect(result.result).toMatchObject({
      open: true,
      ranges: [
        { from: "11:00", to: "15:00" },
        { from: "19:00", to: "23:00" },
      ],
    })
  })

  test("EVT-1: a chat turn writes its events and its version", async () => {
    const io = fakeIo(["hello"])
    const code = await runChat({
      dir: DEMO,
      io,
      brains: [scriptedBrain([{ reply: "Hello." }])],
      db: localSupabase(),
      env: {},
    })
    expect(code).toBe(0)

    const store = createStore(localSupabase(), "demo-restaurant")

    expect((await store.events.list({}, { orderBy: "seq" })).map((row) => row.name)).toEqual([
      "turn_started",
      "turn_ended",
    ])
    expect(await store.versions.count()).toBe(1)
    expect((await store.turns.list())[0]?.version_id).not.toBeNull()
  })
})

describe("openbox chat when something is wrong", () => {
  test("SKILL-6: a folder with no agent in it says what is missing", async () => {
    const io = fakeIo([])
    const code = await runChat({ dir: import.meta.dir, io, env: {} })

    expect(code).toBe(1)
    expect(io.text()).toContain("agent.config.ts")
    expect(io.text()).toContain("prompt.md")
  })

  test("SKILL-6: a missing API key is named, not a stack trace", async () => {
    const io = fakeIo([])
    const code = await runChat({ dir: DEMO, io, db: localSupabase(), env: {} })

    expect(code).toBe(1)
    expect(io.text()).toContain("OPENROUTER_API_KEY")
  })

  test("SKILL-6: a missing database is named too", async () => {
    const io = fakeIo([])
    const code = await runChat({
      dir: DEMO,
      io,
      brains: [scriptedBrain([])],
      env: {},
    })

    expect(code).toBe(1)
    expect(io.text()).toContain("SUPABASE_URL")
  })
})
