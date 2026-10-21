// C13, which is the whole point of M2.
//
// "The same webhook delivered twice is processed once. Three messages
//  inside the burst window produce one turn. Two server processes on one
//  database never process the same person in parallel. A send that times
//  out is never delivered twice: it's resent only on channels that handle
//  duplicates safely, and flagged otherwise."
//
// The pieces each have their own tests in receive, worker, outbox and jobs.
// This file is about the claims as a whole, and above all about the one
// that cannot be checked a piece at a time: two processes, one database,
// and nobody handled twice.
import { test, expect, beforeAll, beforeEach, afterEach } from "bun:test"
import { scriptedDecisionModel } from "../../src/testing/scripted-decision.ts"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { migrate } from "../../src/migrate/index.ts"
import {
  createAgent as buildAgent,
  type Agent,
  type AgentOptions,
  type Deps,
} from "../../src/runtime/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { systemClock } from "../../src/testing/clock.ts"
import { fakeSender } from "../../src/testing/fake-sender.ts"
import type { Brain, BrainOutput } from "../../src/providers/brains/types.ts"
import type { Outbound, SendResult, Sender } from "../../src/runtime/sender.ts"

const PROMPT = "You are the host at a restaurant."
const started: Agent[] = []

function createAgent(options: AgentOptions): Agent {
  const agent = buildAgent(options)
  started.push(agent)
  return agent
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((agent) => agent.stop()))
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
    workerPollMs: 20,
    sendAttempts: 3,
    sendBackoffMs: 1,
    ...over,
  })
}

/**
 * Watches who is being handled, so "never in parallel" can be a measured
 * fact rather than a hope. Shared by both processes in a test, because the
 * claim is about both of them at once.
 */
function watcher() {
  const inside = new Map<string, number>()
  const worst = new Map<string, number>()
  /** Which process answered each message, to catch a vacuous pass. */
  const byProcess = new Map<string, number>()

  return {
    worst,
    byProcess,
    /** A brain that records who it is working for, and for how long. */
    brain(id: string, reply: string, holdMs = 25): Brain {
      return {
        id,
        kind: "api",
        supportsImages: false,
        async complete(input): Promise<BrainOutput> {
          // The person is not on the input, so the system prompt's role
          // line is no use here: use the message text, which the tests
          // make unique per person.
          const who = input.messages.map((m) => ("text" in m ? m.text : "")).join("|")
          const now = (inside.get(who) ?? 0) + 1
          inside.set(who, now)
          worst.set(who, Math.max(worst.get(who) ?? 0, now))
          byProcess.set(id, (byProcess.get(id) ?? 0) + 1)

          await new Promise((resolve) => setTimeout(resolve, holdMs))
          inside.set(who, (inside.get(who) ?? 1) - 1)
          return {
            text: reply,
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          }
        },
      }
    },
  }
}

/** A sender whose answer per attempt is scripted. */
function scriptedSender(
  answers: (SendResult | "throw")[],
  idempotentSends = false,
): Sender & { tries: Outbound[] } {
  const tries: Outbound[] = []
  let next = 0
  return {
    tries,
    capabilities: () => ({ buttons: true, files: true, templates: false, idempotentSends }),
    async send(out: Outbound): Promise<SendResult> {
      tries.push(out)
      const answer = answers[Math.min(next, answers.length - 1)]
      next++
      if (answer === "throw") throw new Error("the gateway never answered")
      return answer ?? { status: "sent", channelMessageId: `ok-${next}` }
    },
  }
}

describeDatabase("C13: messy delivery", (sql) => {
  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  const from = (id: string, over: Record<string, unknown> = {}) => ({
    channel: "whatsapp",
    channelUserId: id,
    channelMessageId: `${id}-1`,
    text: `person ${id} asking`,
    ...over,
  })

  test("C13: the same webhook delivered twice is processed once", async () => {
    // Both processes get the retry, as a load balancer would deliver it.
    const sender = fakeSender()
    const deps = (): Deps => ({
      decisionModel: scriptedDecisionModel([]),
      brains: [watcher().brain("b", "We open at 11.")],
      db: localSupabase(),
      sender,
      clock: systemClock,
    })
    const first = createAgent({ config: config(), deps: deps(), prompt: PROMPT, tools: [] })
    const second = createAgent({ config: config(), deps: deps(), prompt: PROMPT, tools: [] })

    const [a, b] = await Promise.all([first.receive(from("1")), second.receive(from("1"))])
    first.start()
    second.start()
    await first.settled()
    await second.settled()

    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true])
    expect(await first.store.inbox.count()).toBe(1)
    expect(await first.store.turns.count()).toBe(1)
    expect(sender.sent).toHaveLength(1)
  })

  test("C13: three messages inside the burst window produce one turn", async () => {
    const sender = fakeSender()
    const seen = watcher()
    const agent = createAgent({
      // A real window, so this is the window doing the work and not a zero.
      config: config({ burstWindowMs: 250 }),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [seen.brain("b", "All three, noted.")],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })

    agent.start()
    await agent.receive(from("1", { channelMessageId: "a", text: "hi" }))
    await agent.receive(from("1", { channelMessageId: "b", text: "are you open" }))
    await agent.receive(from("1", { channelMessageId: "c", text: "tonight" }))

    // Nothing may run while the window is open.
    await new Promise((r) => setTimeout(r, 120))
    expect(await agent.store.turns.count()).toBe(0)

    // `settled` waits for work that is ready, and a message inside its
    // burst window is not ready yet, so the window has to pass first.
    await new Promise((r) => setTimeout(r, 200))
    await agent.settled()
    expect(await agent.store.turns.count()).toBe(1)
    expect(sender.texts()).toEqual(["All three, noted."])
    expect(await agent.store.inbox.count({ status: "done" })).toBe(3)
  })

  test("C13: two processes on one database never handle the same person at once", async () => {
    const seen = watcher()
    const sender = fakeSender()
    const build = (id: string) =>
      createAgent({
        config: config(),
        deps: {
          decisionModel: scriptedDecisionModel([]),
          brains: [seen.brain(id, "answered")],
          db: localSupabase(),
          sender,
          clock: systemClock,
        },
        prompt: PROMPT,
        tools: [],
      })

    const first = build("first")
    const second = build("second")

    // Eight people, each messaging twice, with both processes competing.
    const people = ["1", "2", "3", "4", "5", "6", "7", "8"]
    for (const id of people) {
      await first.receive(from(id, { channelMessageId: `${id}-a`, text: `person ${id} asking` }))
    }
    first.start()
    second.start()
    for (const id of people) {
      await second.receive(from(id, { channelMessageId: `${id}-b`, text: `person ${id} again` }))
    }

    await first.settled()
    await second.settled()

    // The claim: nobody was ever inside two turns at the same time.
    for (const [who, worst] of seen.worst) {
      expect(worst, `person ${who} was handled ${worst} times at once`).toBe(1)
    }

    // And the test was not vacuous: both processes really did work, so the
    // competition being tested actually happened.
    expect(seen.byProcess.get("first") ?? 0).toBeGreaterThan(0)
    expect(seen.byProcess.get("second") ?? 0).toBeGreaterThan(0)
    expect(await first.store.inbox.count({ status: "done" })).toBe(16)
  })

  test("C13: one person's messages are answered in the order they were sent", async () => {
    const sender = fakeSender()
    const seen = watcher()
    const agent = createAgent({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [seen.brain("b", "ok")],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })

    agent.start()
    for (const n of [1, 2, 3, 4]) {
      await agent.receiveAndWait(from("1", { channelMessageId: `m${n}`, text: `question ${n}` }))
    }

    const stored = await agent.store.messages.list({}, { orderBy: "seq" })
    expect(stored.map((row) => row.text)).toEqual([
      "question 1",
      "ok",
      "question 2",
      "ok",
      "question 3",
      "ok",
      "question 4",
      "ok",
    ])
  })

  test("C13: a send that timed out is not delivered twice", async () => {
    // The channel cannot say whether it went through, so the core does not
    // send it again. It is recorded as unknown, which is not a failure.
    const sender = scriptedSender(["throw"])
    const agent = createAgent({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [watcher().brain("b", "We open at 11.")],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })

    agent.start()
    await agent.receiveAndWait(from("1"))

    expect(sender.tries).toHaveLength(1)
    const row = (await agent.store.outbox.list())[0]
    expect(row?.status).toBe("unknown")
    expect(await agent.store.events.count({ name: "send_unknown" })).toBe(1)
  })

  test("C13: it is resent on a channel that handles duplicates safely", async () => {
    const sender = scriptedSender(["throw", { status: "sent", channelMessageId: "ok" }], true)
    const agent = createAgent({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [watcher().brain("b", "We open at 11.")],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })

    agent.start()
    await agent.receiveAndWait(from("1"))

    expect(sender.tries).toHaveLength(2)
    expect((await agent.store.outbox.list())[0]?.status).toBe("sent")
  })

  test("C13: a failed send is retried and gets through", async () => {
    const sender = scriptedSender([
      { status: "rejected", retryable: true, error: "rate limited" },
      { status: "sent", channelMessageId: "ok" },
    ])
    const agent = createAgent({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [watcher().brain("b", "We open at 11.")],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })

    agent.start()
    await agent.receiveAndWait(from("1"))

    expect(sender.tries).toHaveLength(2)
    expect((await agent.store.outbox.list())[0]?.status).toBe("sent")
  })

  test("C13: a send that went through is never repeated", async () => {
    // Queuing the same message again, as a retried turn would, sends once.
    const sender = fakeSender()
    const agent = createAgent({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [watcher().brain("b", "We open at 11.")],
        db: localSupabase(),
        sender,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })

    agent.start()
    const result = await agent.receiveAndWait(from("1"))
    const queued = (await agent.store.outbox.list())[0]
    const person = await agent.store.people.find({})

    await agent.outbox.queue({
      personId: person?.id ?? "",
      kind: "reply",
      channel: "whatsapp",
      channelUserId: "1",
      text: "We open at 11.",
      idempotencyKey: queued?.idempotency_key ?? "",
    })
    await agent.settled()

    expect(result.turn?.outcome).toBe("replied")
    expect(await agent.store.outbox.count()).toBe(1)
    expect(sender.sent).toHaveLength(1)
  })
})
