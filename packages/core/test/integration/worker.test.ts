// LOOP-2 to LOOP-4 and DATA-4: the worker, the lease and the burst merge.
//
// These are the tests that have to hold for two processes, not one, so most
// of them build a second agent against the same database and make the two
// compete. Nothing sleeps where a gate will do.
import { test, expect, beforeEach } from "bun:test"
import { scriptedDecisionModel } from "../../src/testing/scripted-decision.ts"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { check } from "../support/waiting.ts"
import { createLeases, FREE, type Agent, type Deps } from "../../src/runtime/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { scriptedBrain, type ScriptedBrain } from "../../src/testing/scripted-brain.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock, systemClock, type FixedClock } from "../../src/testing/clock.ts"
import { createStore } from "../../src/store/index.ts"
import type { Brain, BrainOutput } from "../../src/providers/brains/types.ts"

const PROMPT = "You are the host at a restaurant."

// Every agent that was started has to be stopped, or its poll timer keeps
// the test runner alive. Gates are opened first: a brain still waiting on
// one would keep `stop()` waiting for ever.
const agents = trackAgents("worker.test.ts", {
  beforeStop: () => {
    for (const open of gates.splice(0)) open()
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
    workerPollMs: 25,
    ...over,
  })
}

/**
 * A promise someone else decides when to resolve.
 *
 * Every gate is registered, and `afterEach` opens them all before stopping
 * anything. Without that, one failed assertion leaves its brain blocked
 * for ever, `stop()` waits for it, the cleanup hook times out, and the
 * agent keeps running with its own sender for the rest of the suite,
 * quietly doing other files' work. That is a cascade worth making
 * impossible rather than remembering not to cause.
 */
const gates: (() => void)[] = []

function gate(): { open: () => void; opened: Promise<void> } {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  gates.push(open)
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
  let sender: FakeSender

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  /** An agent with the worker running, cleaned up after the test. */
  function agentWith(
    brains: Brain[],
    over: Record<string, unknown> = {},
    clock = systemClock,
  ): Agent {
    sender = fakeSender()
    const deps: Deps = {
      brains,
      decisionModel: scriptedDecisionModel([]),
      db: localSupabase(),
      sender,
      clock,
    }
    return agents.create({ config: config(over), deps, prompt: PROMPT, tools: [] })
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
  /**
   * Waits until the lease has actually been claimed.
   *
   * `inFlight()` goes up when the pump picks a person, which is before
   * `handle()` has taken their lease. Reading the lease on the strength of
   * `inFlight()` alone is a race that only shows up on a slow machine.
   */
  async function untilClaimed(agent: Agent): Promise<{ owner: string | null; expires_at: string }> {
    for (;;) {
      const lease = await agent.store.leases.find({})
      if (lease !== null && lease.owner !== null) return lease
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

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
    const idle = agents.build({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [brain],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
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
    const idle = agents.build({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [scriptedBrain([])],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })

    await expect(idle.receiveAndWait(hello())).rejects.toThrow(/agent\.start\(\)/)
  })

  test("LOOP-2: the worker takes the person's lease while it works", async () => {
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)])

    await agent.receive(hello())

    const lease = await untilClaimed(agent)
    expect(lease.owner).toBe(agent.owner)
    expect(new Date(lease.expires_at).getTime()).toBeGreaterThan(Date.now())

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
    await untilClaimed(first)

    // A second process, on the same database, with work apparently waiting.
    const secondSender = fakeSender()
    const secondBrain = scriptedBrain([{ reply: "from the second" }])
    const second = agents.build({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [secondBrain],
        db: localSupabase(),
        sender: secondSender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })
    second.start()

    await new Promise((r) => setTimeout(r, 150))
    // It cannot have the person, so it has nothing to do.
    expect(second.inFlight()).toBe(0)
    expect(secondBrain.calls).toHaveLength(0)

    held.open()
    // Both, because either process may deliver a reply the other wrote.
    // See below: waiting only for the first is what made this test fail
    // about one run in three under load (Known K22).
    await first.settled()
    await second.settled()

    // LOOP-2 is a claim about turns, not about which process sends.
    //
    // This test used to assert that the first agent's own sender delivered
    // the reply, and failed intermittently under load because that is not
    // something the core promises. Both agents here are the same agent on
    // the same database, so they share one outbox, and a queued row is
    // taken by whichever pump wins the conditional claim. That is the
    // feature that lets a reply survive the process that composed it
    // dying, not a fault. Under load the second pump sometimes won, and
    // the message went out through its sender instead.
    //
    // So what is asserted is what LOOP-2 actually guarantees: the second
    // worker never ran a turn for a person the first was handling, the
    // reply was written by the first agent's brain, and it went out
    // exactly once between the two of them.
    const delivered = [...sender.sent, ...secondSender.sent]
    await check(first, undefined, () => {
      expect(secondBrain.calls).toHaveLength(0)
      expect(delivered.map((message) => message.text)).toEqual(["from the first"])
    })
    expect(second.inFlight()).toBe(0)
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
    const writer = agents.build({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [brain],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })

    await writer.receive(hello({ channelMessageId: "a", text: "hi" }))
    await writer.receive(hello({ channelMessageId: "b", text: "are you open?" }))
    await writer.receive(hello({ channelMessageId: "c", text: "tonight I mean" }))

    writer.start()
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
    const writer = agents.build({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [brain],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })
    await writer.receive(hello({ channelMessageId: "a", text: "one" }))
    await writer.receive(hello({ channelMessageId: "b", text: "two" }))

    writer.start()
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
    const writer = agents.build({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [brain],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })
    await writer.receive(hello({ channelMessageId: "a", text: "one" }))
    await writer.receive(hello({ channelMessageId: "b", text: "two" }))
    writer.start()
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
    // Same race as above: picked is not yet claimed, so wait for the
    // claims rather than reading them the instant the slots fill.
    while ((await agent.store.leases.count({ owner: agent.owner })) < 4) {
      await new Promise((r) => setTimeout(r, 5))
    }

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
    await untilClaimed(agent)

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
    const other = agents.build({
      config: config({ name: "dentist" }),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [scriptedBrain([{ reply: "wrong agent" }])],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })
    other.start()

    const mine = agentWith([scriptedBrain([{ reply: "right agent" }])])
    await mine.receiveAndWait(hello())
    await new Promise((r) => setTimeout(r, 150))

    expect(await other.store.turns.count()).toBe(0)
    expect(await mine.store.turns.count()).toBe(1)
  })
})
