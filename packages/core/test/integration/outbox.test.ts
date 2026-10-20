// LOOP-11 and the Sender contract: the outbox.
//
// The three outcomes of a send are what this is really about, and the third
// one is the interesting one: a send that threw may already have arrived,
// so it is `unknown` rather than failed, and saying it again is worse than
// not knowing.
import { test, expect, beforeAll, beforeEach, afterEach } from "bun:test"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { migrate } from "../../src/migrate/index.ts"
import {
  createAgent as buildAgent,
  backoffMs,
  type Agent,
  type AgentOptions,
  type Deps,
} from "../../src/runtime/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { scriptedBrain } from "../../src/testing/scripted-brain.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { systemClock } from "../../src/testing/clock.ts"
import type { Outbound, SendResult, Sender } from "../../src/runtime/sender.ts"

const PROMPT = "You are the host at a restaurant."

const started: Agent[] = []

function createAgent(options: AgentOptions): Agent {
  const agent = buildAgent(options)
  agent.start()
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
    workerPollMs: 25,
    // Short, so a test is not waiting out a real thirty second backoff.
    sendAttempts: 3,
    sendBackoffMs: 1,
    ...over,
  })
}

/** A sender whose answer is scripted per attempt. */
function scriptedSender(
  answers: (SendResult | "throw")[],
  capabilities: { idempotentSends?: boolean } = {},
): Sender & { tries: Outbound[] } {
  const tries: Outbound[] = []
  let next = 0

  return {
    tries,
    capabilities: () => ({
      buttons: true,
      files: true,
      templates: false,
      idempotentSends: capabilities.idempotentSends ?? false,
    }),
    async send(out: Outbound): Promise<SendResult> {
      tries.push(out)
      const answer = answers[Math.min(next, answers.length - 1)]
      next++
      if (answer === "throw") throw new Error("the gateway never answered")
      return answer ?? { status: "sent", channelMessageId: `ok-${next}` }
    },
  }
}

describeDatabase("the outbox", (sql) => {
  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  function agentWith(sender: Sender, over: Record<string, unknown> = {}): Agent {
    const deps: Deps = {
      brains: [scriptedBrain([{ reply: "We open at 11." }])],
      db: localSupabase(),
      sender,
      clock: systemClock,
    }
    return createAgent({ config: config(over), deps, prompt: PROMPT, tools: [] })
  }

  const hello = (over: Record<string, unknown> = {}) => ({
    channel: "whatsapp",
    channelUserId: "42",
    channelMessageId: "msg-1",
    text: "Any space on Monday?",
    ...over,
  })

  test("LOOP-11: a reply goes to the outbox, and the outbox sends it", async () => {
    const sender: FakeSender = fakeSender()
    const agent = agentWith(sender)

    await agent.receiveAndWait(hello())

    const row = (await agent.store.outbox.list())[0]
    expect(row?.kind).toBe("reply")
    expect(row?.status).toBe("sent")
    expect(row?.attempts).toBe(1)
    expect(row?.payload).toEqual({ text: "We open at 11." })
    expect(row?.channel).toBe("whatsapp")
    expect(row?.channel_user_id).toBe("42")
    expect(sender.texts()).toEqual(["We open at 11."])
  })

  test("LOOP-11: the row keeps what the channel called the message", async () => {
    const agent = agentWith(scriptedSender([{ status: "sent", channelMessageId: "wamid.123" }]))

    await agent.receiveAndWait(hello())

    const row = (await agent.store.outbox.list())[0]
    expect(row?.channel_message_id).toBe("wamid.123")
    expect(row?.error).toBeNull()
    expect(row?.last_attempt_at).not.toBeNull()
  })

  test("LOOP-11: the reply is tied to the turn that decided it", async () => {
    const agent = agentWith(fakeSender())
    await agent.receiveAndWait(hello())

    const turn = (await agent.store.turns.list())[0]
    const row = (await agent.store.outbox.list())[0]
    expect(row?.turn_id).toBe(turn?.id ?? "")
  })

  test("SEND-1: the same idempotency key twice is one message", async () => {
    const sender: FakeSender = fakeSender()
    const agent = agentWith(sender)
    const person = await agent.store.people.insert({ channel: "whatsapp", channel_user_id: "7" })

    const once = await agent.outbox.queue({
      personId: person.id,
      kind: "reply",
      channel: "whatsapp",
      channelUserId: "7",
      text: "first",
      idempotencyKey: "same-key",
    })
    const twice = await agent.outbox.queue({
      personId: person.id,
      kind: "reply",
      channel: "whatsapp",
      channelUserId: "7",
      // Whoever queued it first decided what it says.
      text: "second",
      idempotencyKey: "same-key",
    })

    expect(twice.id).toBe(once.id)
    expect(await agent.store.outbox.count()).toBe(1)
    await agent.settled()
    expect(sender.texts()).toEqual(["first"])
  })

  test("SEND-1: a refusal that can be retried is tried again, and gets through", async () => {
    const sender = scriptedSender([
      { status: "rejected", retryable: true, error: "rate limited" },
      { status: "sent", channelMessageId: "ok" },
    ])
    const agent = agentWith(sender)

    await agent.receiveAndWait(hello())

    expect(sender.tries).toHaveLength(2)
    const row = (await agent.store.outbox.list())[0]
    expect(row?.status).toBe("sent")
    expect(row?.attempts).toBe(2)
  })

  test("SEND-3: a refusal that keeps coming becomes failed after sendAttempts", async () => {
    const sender = scriptedSender([{ status: "rejected", retryable: true, error: "still down" }])
    const agent = agentWith(sender)

    await agent.receiveAndWait(hello())

    // Three attempts, which is this config's sendAttempts, then it stops.
    expect(sender.tries).toHaveLength(3)
    const row = (await agent.store.outbox.list())[0]
    expect(row?.status).toBe("failed")
    expect(row?.attempts).toBe(3)
    expect(row?.error).toContain("still down")

    const failed = (await agent.store.events.list({ name: "send_failed" }))[0]
    expect(failed?.props).toMatchObject({ kind: "reply", attempts: 3, retryable: true })
  })

  test("SEND-1: a refusal that says not to retry is not retried", async () => {
    const sender = scriptedSender([
      { status: "rejected", retryable: false, error: "this number is blocked" },
    ])
    const agent = agentWith(sender)

    await agent.receiveAndWait(hello())

    expect(sender.tries).toHaveLength(1)
    const row = (await agent.store.outbox.list())[0]
    expect(row?.status).toBe("failed")
    expect(row?.attempts).toBe(1)
    expect(await agent.store.events.count({ name: "send_failed" })).toBe(1)
  })

  test("SEND-2: a send that threw is unknown, not failed, and is not sent again", async () => {
    // The Sender contract: a throw means the outcome is unknown. The
    // message may have arrived, and saying it twice is worse than not
    // knowing, so this is where it stops.
    const sender = scriptedSender(["throw"])
    const agent = agentWith(sender)

    await agent.receiveAndWait(hello())

    expect(sender.tries).toHaveLength(1)
    const row = (await agent.store.outbox.list())[0]
    expect(row?.status).toBe("unknown")
    expect(row?.attempts).toBe(1)
    expect(row?.error).toContain("never answered")

    const unknown = (await agent.store.events.list({ name: "send_unknown" }))[0]
    expect(unknown?.props).toMatchObject({ kind: "reply", attempts: 1, retrying: false })
    // It is not a failure, so it is not recorded as one.
    expect(await agent.store.events.count({ name: "send_failed" })).toBe(0)
  })

  test("SEND-2: a channel that can take the same send twice does retry an unknown one", async () => {
    // `idempotentSends` is what that capability is for: on such a channel
    // a repeat cannot be seen by the person, so trying again is safe.
    const sender = scriptedSender(["throw", { status: "sent", channelMessageId: "ok" }], {
      idempotentSends: true,
    })
    const agent = agentWith(sender)

    await agent.receiveAndWait(hello())

    expect(sender.tries).toHaveLength(2)
    const row = (await agent.store.outbox.list())[0]
    expect(row?.status).toBe("sent")
  })

  test("SEND-2: an idempotent channel that keeps throwing still ends as unknown", async () => {
    const sender = scriptedSender(["throw"], { idempotentSends: true })
    const agent = agentWith(sender)

    await agent.receiveAndWait(hello())

    expect(sender.tries).toHaveLength(3)
    const row = (await agent.store.outbox.list())[0]
    expect(row?.status).toBe("unknown")
  })

  test("SEND-3: a refusal pushes the next attempt out, rather than hammering", async () => {
    const sender = scriptedSender([{ status: "rejected", retryable: true, error: "slow down" }])
    // A backoff long enough to observe, and only one attempt allowed after
    // it, so the test does not sit through the whole schedule.
    const agent = agentWith(sender, { sendBackoffMs: 30_000, sendAttempts: 2 })

    await agent.receive(hello())
    // Wait for the first attempt to come back.
    while (sender.tries.length === 0) await new Promise((r) => setTimeout(r, 5))
    await new Promise((r) => setTimeout(r, 100))

    const row = (await agent.store.outbox.list())[0]
    expect(row?.status).toBe("queued")
    expect(row?.attempts).toBe(1)
    // Not due again yet, so nothing has hammered the channel.
    expect(new Date(row?.not_before ?? 0).getTime()).toBeGreaterThan(Date.now())
    expect(sender.tries).toHaveLength(1)
  })

  test("API-2: receiveAndWait waits for the send to reach a final state", async () => {
    const sender = scriptedSender([
      { status: "rejected", retryable: true, error: "once" },
      { status: "sent", channelMessageId: "ok" },
    ])
    const agent = agentWith(sender)

    await agent.receiveAndWait(hello())

    // Already final by the time it resolved, retry and all.
    const row = (await agent.store.outbox.list())[0]
    expect(row?.status).toBe("sent")
  })

  test("API-2: it resolves even when the send ends badly", async () => {
    const sender = scriptedSender([{ status: "rejected", retryable: false, error: "blocked" }])
    const agent = agentWith(sender)

    const result = await agent.receiveAndWait(hello())

    // The turn still replied: the agent decided what to say and said it.
    // Whether the channel took it is the outbox's business, not the turn's.
    expect(result.turn?.outcome).toBe("replied")
    const row = (await agent.store.outbox.list())[0]
    expect(row?.status).toBe("failed")
  })

  test("a reply the channel refused is still in the conversation", async () => {
    const agent = agentWith(scriptedSender([{ status: "rejected", retryable: false, error: "no" }]))
    await agent.receiveAndWait(hello())

    // What the agent said is part of the record whatever the channel did,
    // or the next turn's history would have a hole in it.
    const messages = await agent.store.messages.list({}, { orderBy: "seq" })
    expect(messages.map((row) => [row.direction, row.text])).toEqual([
      ["inbound", "Any space on Monday?"],
      ["outbound", "We open at 11."],
    ])
  })

  test("SEND-4: one person's messages go out in order, never two at once", async () => {
    const order: string[] = []
    let inside = 0
    const sender: Sender = {
      capabilities: () => ({
        buttons: true,
        files: true,
        templates: false,
        idempotentSends: false,
      }),
      async send(out: Outbound): Promise<SendResult> {
        inside++
        // Two sends to one person at once would put them out of order.
        expect(inside).toBe(1)
        await new Promise((r) => setTimeout(r, 20))
        order.push(out.text ?? "")
        inside--
        return { status: "sent", channelMessageId: "ok" }
      },
    }

    const agent = agentWith(sender)
    const person = await agent.store.people.insert({ channel: "whatsapp", channel_user_id: "9" })

    for (const text of ["first", "second", "third"]) {
      await agent.outbox.queue({
        personId: person.id,
        kind: "reply",
        channel: "whatsapp",
        channelUserId: "9",
        text,
        idempotencyKey: `k-${text}`,
      })
    }
    await agent.settled()

    expect(order).toEqual(["first", "second", "third"])
  })

  test("DATA-4: two processes cannot both send the same message", async () => {
    const first = fakeSender()
    const second = fakeSender()
    const agent = agentWith(first)
    const other = createAgent({
      config: config(),
      deps: {
        brains: [scriptedBrain([{ reply: "x" }])],
        db: localSupabase(),
        sender: second,
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })

    await agent.receiveAndWait(hello())
    await other.settled()
    await agent.settled()

    // One message, sent once, by one of them.
    expect(await agent.store.outbox.count()).toBe(1)
    expect(first.sent.length + second.sent.length).toBe(1)
  })

  test("DATA-1: another agent's outbox is invisible", async () => {
    const agent = agentWith(fakeSender())
    await agent.receiveAndWait(hello())

    const other = createAgent({
      config: config({ name: "dentist" }),
      deps: {
        brains: [scriptedBrain([{ reply: "x" }])],
        db: localSupabase(),
        sender: fakeSender(),
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: [],
    })

    expect(await other.store.outbox.count()).toBe(0)
    expect(await agent.store.outbox.count()).toBe(1)
  })
})

test("SEND-3: the backoff doubles, and is jittered so a thousand do not return together", () => {
  // Jitter is plus or minus 15 per cent of the doubling schedule.
  for (const [attempts, centre] of [
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [5, 16000],
  ] as const) {
    const seen = new Set<number>()
    for (let i = 0; i < 50; i++) {
      const ms = backoffMs(attempts, 1000)
      seen.add(ms)
      expect(ms).toBeGreaterThanOrEqual(Math.floor(centre * 0.85))
      expect(ms).toBeLessThanOrEqual(Math.ceil(centre * 1.15))
    }
    // Not a fixed number, or an outage would send them all back at once.
    expect(seen.size).toBeGreaterThan(1)
  }
})
