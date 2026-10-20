// LOOP-2 to LOOP-4 and DATA-4: the worker, the lease and the burst merge.
//
// These are the tests that have to hold for two processes, not one, so most
// of them build a second agent against the same database and make the two
// compete. Nothing sleeps where a gate will do.
import { test, expect, beforeAll, beforeEach, afterEach } from "bun:test"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { migrate } from "../../src/migrate/index.ts"
import { createAgent, createLeases, FREE, type Agent, type Deps } from "../../src/runtime/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { scriptedBrain, type ScriptedBrain } from "../../src/testing/scripted-brain.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock, systemClock, type FixedClock } from "../../src/testing/clock.ts"
import { createStore } from "../../src/store/index.ts"
import type { Brain, BrainOutput } from "../../src/providers/brains/types.ts"

const PROMPT = "You are the host at a restaurant."

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
    workerPollMs: 25,
    ...over,
  })
}

function gate(): { open: () => void; opened: Promise<void> } {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

function gatedBrain(opened: Promise<void>, text = "We open at 11."): Brain {
  return {
    id: "gated",
    kind: "api",
    supportsImages: false,
    async complete(): Promise<BrainOutput> {
      await opened
      return { text, finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
    },
  }
}

describeDatabase("the worker", (sql) => {
  const started: Agent[] = []
  let sender: FakeSender

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  // Every agent that was started has to be stopped, or its poll timer keeps
  // the test runner alive.
  afterEach(async () => {
    await Promise.all(started.splice(0).map((agent) => agent.stop()))
  })

  /** An agent with the worker running, cleaned up after the test. */
  function agentWith(
    brains: Brain[],
    over: Record<string, unknown> = {},
    clock = systemClock,
  ): Agent {
    sender = fakeSender()
    const deps: Deps = { brains, db: localSupabase(), sender, clock }
    const agent = createAgent({ config: config(over), deps, prompt: PROMPT, tools: [] })
    agent.start()
    started.push(agent)
    return agent
  }

  /**
   * Waits until a turn has actually taken this message.
   *
   * `inFlight()` goes up when the worker picks the person, which is before
   * it reads their waiting rows. A message written in that gap still joins
   * the first turn, correctly: the batch is taken at one moment and that
   * moment is when the row stops being pending. Tests about what lands in
   * the *next* turn have to wait for it.
   */
  async function untilTaken(agent: Agent, inboxId: string): Promise<void> {
    for (;;) {
      const row = await agent.store.inbox.byId(inboxId)
      if (row !== null && row.status !== "pending") return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  const hello = (over: Record<string, unknown> = {}) => ({
    channel: "whatsapp",
    channelUserId: "42",
    channelMessageId: "msg-1",
    text: "Any space on Monday?",
    ...over,
  })

  test("LOOP-2: nothing is handled until the worker is started", async () => {
    sender = fakeSender()
    const brain = scriptedBrain([{ reply: "hi" }])
    const idle = createAgent({
      config: config(),
      deps: { brains: [brain], db: localSupabase(), sender, clock: systemClock },
      prompt: PROMPT,
      tools: [],
    })

    const result = await idle.receive(hello())

    // The message is safe, and nobody has touched it.
    expect(result.duplicate).toBe(false)
    expect(brain.calls).toHaveLength(0)
    const row = await idle.store.inbox.byId(result.inboxId)
    expect(row?.status).toBe("pending")

    // Another process picks it up, which is the shape a webhook runs in.
    const worker = agentWith([scriptedBrain([{ reply: "We open at 11." }])])
    await worker.settled()
    expect(sender.texts()).toEqual(["We open at 11."])
  })

  test("LOOP-2: receiveAndWait says so rather than hanging with no worker", async () => {
    sender = fakeSender()
    const idle = createAgent({
      config: config(),
      deps: { brains: [scriptedBrain([])], db: localSupabase(), sender, clock: systemClock },
      prompt: PROMPT,
      tools: [],
    })

    await expect(idle.receiveAndWait(hello())).rejects.toThrow(/agent\.start\(\)/)
  })

  test("LOOP-2: the worker takes the person's lease while it works", async () => {
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)])

    await agent.receive(hello())
    // Wait for the claim to land, without guessing how long that takes.
    while (agent.inFlight() === 0) await new Promise((r) => setTimeout(r, 5))

    const lease = await agent.store.leases.find({})
    expect(lease?.owner).toBe(agent.owner)
    expect(new Date(lease?.expires_at ?? 0).getTime()).toBeGreaterThan(Date.now())

    held.open()
    await agent.settled()

    // LOOP-11: released at the end, so another worker can take them at once.
    const after = await agent.store.leases.find({})
    expect(new Date(after?.expires_at ?? 0).getTime()).toBeLessThanOrEqual(Date.now())
  })

  test("LOOP-2: a person being handled is never taken by a second worker", async () => {
    const held = gate()
    const first = agentWith([gatedBrain(held.opened, "from the first")])

    await first.receive(hello())
    while (first.inFlight() === 0) await new Promise((r) => setTimeout(r, 5))

    // A second process, on the same database, with work apparently waiting.
    const secondSender = fakeSender()
    const secondBrain = scriptedBrain([{ reply: "from the second" }])
    const second = createAgent({
      config: config(),
      deps: {
        brains: [secondBrain],
        db: localSupabase(),
        sender: secondSender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })
    second.start()
    started.push(second)

    await new Promise((r) => setTimeout(r, 150))
    // It cannot have the person, so it has nothing to do.
    expect(second.inFlight()).toBe(0)
    expect(secondBrain.calls).toHaveLength(0)

    held.open()
    await first.settled()
    expect(sender.texts()).toEqual(["from the first"])
    expect(secondSender.sent).toEqual([])
  })

  test("DATA-4: of two workers reaching for the same person, exactly one wins", async () => {
    const agent = agentWith([scriptedBrain([{ reply: "hi" }])])
    await agent.receiveAndWait(hello())
    // Stopped, so the only thing reaching for this lease is the test.
    await agent.stop()
    const personId = (await agent.store.people.find({}))?.id ?? ""

    const store = createStore(localSupabase(), "restaurant")
    const clock = systemClock
    const racers = ["a", "b", "c", "d", "e"].map((owner) =>
      createLeases({ store, clock, owner, seconds: 60 }),
    )

    await store.leases.update({ person_id: personId }, { expires_at: FREE })
    const claims = await Promise.all(racers.map((lease) => lease.claim(personId)))

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1)
  })

  test("DATA-4: an expired lease can be taken, a live one cannot", async () => {
    const agent = agentWith([scriptedBrain([{ reply: "hi" }])])
    await agent.receiveAndWait(hello())
    await agent.stop()
    const personId = (await agent.store.people.find({}))?.id ?? ""

    const store = createStore(localSupabase(), "restaurant")
    const mine = createLeases({ store, clock: systemClock, owner: "mine", seconds: 60 })
    const theirs = createLeases({ store, clock: systemClock, owner: "theirs", seconds: 60 })

    expect(await mine.claim(personId)).not.toBeNull()
    expect(await theirs.claim(personId)).toBeNull()

    // A process that died leaves the lease to expire, and the person is
    // then taken over without anyone having to notice.
    await store.leases.update({ person_id: personId }, { expires_at: FREE })
    expect(await theirs.claim(personId)).not.toBeNull()
    // And the one that lost it cannot renew it back.
    expect(await mine.renew(personId)).toBe(false)
  })

  test("DATA-4: renewing pushes the expiry out while the lease is ours", async () => {
    const agent = agentWith([scriptedBrain([{ reply: "hi" }])])
    await agent.receiveAndWait(hello())
    await agent.stop()
    const personId = (await agent.store.people.find({}))?.id ?? ""

    const store = createStore(localSupabase(), "restaurant")
    const clock = fixedClock(new Date()) as FixedClock
    const mine = createLeases({ store, clock, owner: "mine", seconds: 60 })

    const first = await mine.claim(personId)
    clock.advance(30_000)
    expect(await mine.renew(personId)).toBe(true)

    const after = await store.leases.find({ person_id: personId })
    expect(new Date(after?.expires_at ?? 0).getTime()).toBeGreaterThan(
      new Date(first?.expires_at ?? 0).getTime(),
    )
  })

  test("LOOP-3: messages waiting together become one turn, in arrival order", async () => {
    const brain = scriptedBrain([{ reply: "All three, noted." }])
    sender = fakeSender()
    // The worker is not running yet, so all three land in the inbox first.
    const writer = createAgent({
      config: config(),
      deps: { brains: [brain], db: localSupabase(), sender, clock: systemClock },
      prompt: PROMPT,
      tools: [],
    })

    await writer.receive(hello({ channelMessageId: "a", text: "hi" }))
    await writer.receive(hello({ channelMessageId: "b", text: "are you open?" }))
    await writer.receive(hello({ channelMessageId: "c", text: "tonight I mean" }))

    writer.start()
    started.push(writer)
    await writer.settled()

    // One turn, one reply, and the brain saw the whole burst.
    expect(await writer.store.turns.count()).toBe(1)
    expect(sender.texts()).toEqual(["All three, noted."])
    expect(brain.calls[0]?.messages).toEqual([
      { role: "person", text: "hi" },
      { role: "person", text: "are you open?" },
      { role: "person", text: "tonight I mean" },
    ])
  })

  test("LOOP-3: every message in the burst is stored and tied to the turn", async () => {
    const brain = scriptedBrain([{ reply: "Noted." }])
    sender = fakeSender()
    const writer = createAgent({
      config: config(),
      deps: { brains: [brain], db: localSupabase(), sender, clock: systemClock },
      prompt: PROMPT,
      tools: [],
    })
    await writer.receive(hello({ channelMessageId: "a", text: "one" }))
    await writer.receive(hello({ channelMessageId: "b", text: "two" }))

    writer.start()
    started.push(writer)
    await writer.settled()

    const turn = (await writer.store.turns.list())[0]
    const inbox = await writer.store.inbox.list({}, { orderBy: "seq" })
    expect(inbox.map((row) => row.status)).toEqual(["done", "done"])
    expect(inbox.every((row) => row.turn_id === turn?.id)).toBe(true)

    const messages = await writer.store.messages.list({}, { orderBy: "seq" })
    expect(messages.map((row) => row.text)).toEqual(["one", "two", "Noted."])
  })

  test("EVT-2: a merged burst is recorded, a single message is not", async () => {
    const brain = scriptedBrain([{ reply: "Noted." }])
    sender = fakeSender()
    const writer = createAgent({
      config: config(),
      deps: { brains: [brain], db: localSupabase(), sender, clock: systemClock },
      prompt: PROMPT,
      tools: [],
    })
    await writer.receive(hello({ channelMessageId: "a", text: "one" }))
    await writer.receive(hello({ channelMessageId: "b", text: "two" }))
    writer.start()
    started.push(writer)
    await writer.settled()

    const merged = (await writer.store.events.list({ name: "burst_merged" }))[0]
    expect(merged?.props).toMatchObject({ messages: 2 })

    // A second person sends one message, which is not a burst.
    await writer.receiveAndWait(hello({ channelUserId: "99", channelMessageId: "z", text: "hi" }))
    expect(await writer.store.events.count({ name: "burst_merged" })).toBe(1)
  })

  test("LOOP-3: a person still mid burst is left alone until the window passes", async () => {
    // A real burst window, and a clock the test moves by hand.
    const clock = fixedClock(new Date())
    const brain = scriptedBrain([{ reply: "Noted." }])
    const agent = agentWith([brain], { burstWindowMs: 3_000 }, clock)

    await agent.receive(hello())
    await new Promise((r) => setTimeout(r, 150))

    // Three seconds have not passed, so nothing has run.
    expect(brain.calls).toHaveLength(0)
    expect(agent.inFlight()).toBe(0)

    clock.advance(3_000)
    await agent.settled()
    expect(brain.calls).toHaveLength(1)
  })

  test("LOOP-4: a message arriving mid turn gets the next turn, not this one", async () => {
    const held = gate()
    const brain = scriptedBrain([{ reply: "first" }, { reply: "second" }])
    sender = fakeSender()

    // The first brain call is held open; the second answers at once.
    let calls = 0
    const staged: Brain = {
      id: "staged",
      kind: "api",
      supportsImages: false,
      async complete(input) {
        calls++
        if (calls === 1) await held.opened
        return brain.complete(input)
      },
    }

    const agent = agentWith([staged])
    const first = await agent.receive(hello({ channelMessageId: "a", text: "one" }))
    await untilTaken(agent, first.inboxId)

    // Arrives while the first turn is running.
    await agent.receive(hello({ channelMessageId: "b", text: "two" }))
    held.open()
    await agent.settled()

    // Two turns, not one merged turn: the second message was not swallowed.
    expect(await agent.store.turns.count()).toBe(2)
    expect(sender.texts()).toEqual(["first", "second"])

    // And the second turn saw the first exchange as history.
    expect(brain.calls[1]?.messages).toEqual([
      { role: "person", text: "one" },
      { role: "agent", text: "first" },
      { role: "person", text: "two" },
    ])
  })

  test("LOOP-4: the follow on turn runs under the same lease, with no gap", async () => {
    const held = gate()
    let calls = 0
    const replies: ScriptedBrain = scriptedBrain([{ reply: "first" }, { reply: "second" }])
    const staged: Brain = {
      id: "staged",
      kind: "api",
      supportsImages: false,
      async complete(input) {
        calls++
        if (calls === 1) await held.opened
        return replies.complete(input)
      },
    }

    const agent = agentWith([staged])
    const first = await agent.receive(hello({ channelMessageId: "a", text: "one" }))
    await untilTaken(agent, first.inboxId)
    await agent.receive(hello({ channelMessageId: "b", text: "two" }))

    const lease = await agent.store.leases.find({})
    held.open()
    await agent.settled()

    // The same lease row throughout: it was never given up and retaken.
    const after = await agent.store.leases.find({})
    expect(after?.id).toBe(lease?.id ?? "")
    expect(await agent.store.turns.count()).toBe(2)
  })

  test("LOOP-2: several people are answered at the same time", async () => {
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)], { workerConcurrency: 4 })

    for (const id of ["1", "2", "3", "4"]) {
      await agent.receive(hello({ channelUserId: id, channelMessageId: `m-${id}` }))
    }
    while (agent.inFlight() < 4) await new Promise((r) => setTimeout(r, 5))

    // Four people, four turns, all waiting on the same brain at once.
    expect(agent.inFlight()).toBe(4)
    held.open()
    await agent.settled()
    expect(sender.sent).toHaveLength(4)
  })

  test("LOOP-2: no more people at once than the config allows", async () => {
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)], { workerConcurrency: 2 })

    for (const id of ["1", "2", "3", "4", "5"]) {
      await agent.receive(hello({ channelUserId: id, channelMessageId: `m-${id}` }))
    }
    while (agent.inFlight() < 2) await new Promise((r) => setTimeout(r, 5))
    await new Promise((r) => setTimeout(r, 150))

    expect(agent.inFlight()).toBe(2)

    // The other three are not lost, just waiting their turn.
    held.open()
    await agent.settled()
    expect(sender.sent).toHaveLength(5)
    expect(await agent.store.turns.count()).toBe(5)
  })

  test("LOOP-2: stop finishes the turn in flight and gives the lease back", async () => {
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)])

    await agent.receive(hello())
    while (agent.inFlight() === 0) await new Promise((r) => setTimeout(r, 5))

    held.open()
    await agent.stop()

    expect(agent.inFlight()).toBe(0)
    expect(sender.texts()).toEqual(["We open at 11."])
    const lease = await agent.store.leases.find({})
    expect(new Date(lease?.expires_at ?? 0).getTime()).toBeLessThanOrEqual(Date.now())
  })

  test("LOOP-2: stopping twice is not an error", async () => {
    const agent = agentWith([scriptedBrain([{ reply: "hi" }])])
    await agent.receiveAndWait(hello())
    await agent.stop()
    await agent.stop()
    expect(agent.inFlight()).toBe(0)
  })

  test("DATA-1: a worker never sees another agent's waiting messages", async () => {
    sender = fakeSender()
    const other = createAgent({
      config: config({ name: "dentist" }),
      deps: {
        brains: [scriptedBrain([{ reply: "wrong agent" }])],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })
    other.start()
    started.push(other)

    const mine = agentWith([scriptedBrain([{ reply: "right agent" }])])
    await mine.receiveAndWait(hello())
    await new Promise((r) => setTimeout(r, 150))

    expect(await other.store.turns.count()).toBe(0)
    expect(await mine.store.turns.count()).toBe(1)
  })
})
