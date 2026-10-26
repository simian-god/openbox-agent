// API-1, API-2 and LOOP-1: what `receive` promises a webhook.
//
// `receive` writes the message down and returns. The turn happens behind
// it, so a webhook can acknowledge in milliseconds however long the brain
// takes. `receiveAndWait` is for a caller that wants the answer: a test, an
// evals adapter, or a terminal.
//
// Nothing here sleeps. A brain held on a gate makes "the turn is still
// running" an exact statement rather than a race.
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
import { scriptedBrain } from "../../src/testing/scripted-brain.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import type { Brain, BrainOutput } from "../../src/providers/brains/types.ts"

// LOOP-2: nothing is handled until a worker runs, and a worker left running
// keeps its poll timer alive after the test. Every agent built here is
// therefore started on the way in and stopped on the way out, by shadowing
// the import rather than touching three dozen call sites.
const started: Agent[] = []

function createAgent(options: AgentOptions): Agent {
  const agent = buildAgent(options)
  agent.start()
  started.push(agent)
  return agent
}

afterEach(async () => {
  // Gates first: a brain still waiting on one would keep `stop()` here
  // for ever.
  for (const open of gates.splice(0)) open()
  await Promise.all(started.splice(0).map((agent) => agent.stop()))
})

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

/** A brain that answers only once its gate is opened. */
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

describeDatabase("receive", (sql) => {
  let sender: FakeSender
  const clock = fixedClock("2026-10-19T06:00:00Z")

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  function agentWith(brains: Brain[], over: Record<string, unknown> = {}): Agent {
    sender = fakeSender()
    const deps: Deps = {
      brains,
      decisionModel: scriptedDecisionModel([]),
      db: localSupabase(),
      sender,
      clock,
    }
    return createAgent({ config: config(over), deps, prompt: PROMPT, tools: [] })
  }

  /** Waits for the worker to actually pick the work up, without guessing. */
  async function untilBusy(agent: Agent, count: number): Promise<void> {
    while (agent.inFlight() < count) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  const hello = (over: Record<string, unknown> = {}) => ({
    channel: "whatsapp",
    channelUserId: "42",
    channelMessageId: "msg-1",
    text: "Any space on Monday?",
    ...over,
  })

  test("API-1: receive returns before the turn has finished", async () => {
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)])

    const result = await agent.receive(hello())

    // The brain is still waiting on its gate, so nothing can have been
    // said yet. This is the whole of API-1: the turn is not awaited.
    expect(result.duplicate).toBe(false)
    expect(result.inboxId).toBeTruthy()
    expect(sender.sent).toEqual([])

    held.open()
    await agent.settled()
    expect(sender.texts()).toEqual(["We open at 11."])
  })

  test("API-1: the message is already written down when receive returns", async () => {
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)])

    const result = await agent.receive(hello())

    // LOOP-1: the person and the inbox row are the synchronous part, so
    // nothing is lost if the process dies a moment later.
    const row = await agent.store.inbox.byId(result.inboxId)
    expect(row?.text).toBe("Any space on Monday?")
    expect(await agent.store.people.count()).toBe(1)

    held.open()
    await agent.settled()
  })

  test("API-1: receive does not wait on a slow brain", async () => {
    // 100 ms is API-1's bar. A brain held for far longer than that would
    // blow it if receive awaited the turn, whatever the machine.
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)])

    // The gate is never opened before this call, so if receive awaited the
    // turn it would never return at all.
    const startedAt = Date.now()
    await agent.receive(hello())
    expect(Date.now() - startedAt).toBeLessThan(1_000)

    held.open()
    await agent.settled()
  })

  test("API-2: receiveAndWait resolves only once the reply has gone out", async () => {
    const agent = agentWith([scriptedBrain([{ reply: "We open at 11." }])])

    const result = await agent.receiveAndWait(hello())

    expect(result.turn?.outcome).toBe("replied")
    expect(result.turn?.reply).toBe("We open at 11.")
    // Every outbound message from the turn has reached a final send state.
    expect(sender.texts()).toEqual(["We open at 11."])
    const turn = (await agent.store.turns.list())[0]
    expect(turn?.ended_at).not.toBeNull()
  })

  test("API-2: it waits for the turn receive already started", async () => {
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)])

    await agent.receive(hello())
    // The same message again. There is no second turn, and waiting lands
    // on the turn the first delivery started.
    setTimeout(held.open, 10)
    const result = await agent.receiveAndWait(hello())

    expect(result.duplicate).toBe(true)
    expect(result.turn?.outcome).toBe("replied")
    expect(sender.texts()).toEqual(["We open at 11."])
  })

  test("API-2: each message waits for its own turn", async () => {
    const agent = agentWith([scriptedBrain([{ reply: "one" }, { reply: "two" }])])

    const first = await agent.receiveAndWait(hello())
    const second = await agent.receiveAndWait(hello({ channelMessageId: "msg-2" }))

    expect(first.turn?.reply).toBe("one")
    expect(second.turn?.reply).toBe("two")
    expect(sender.texts()).toEqual(["one", "two"])
  })

  test("API-2: the answer is out by the time it resolves", async () => {
    const agent = agentWith([scriptedBrain([{ reply: "hi" }])])

    await agent.receiveAndWait(hello())
    // The turn is over and the reply has gone, which is what API-2
    // promises. Handing the person's lease back happens just behind it, so
    // `settled` is what waits for the worker to be idle as well.
    expect(sender.texts()).toEqual(["hi"])
    await agent.settled()
    expect(agent.inFlight()).toBe(0)
  })

  test("LOOP-1: the same channel message id twice is a duplicate", async () => {
    const agent = agentWith([scriptedBrain([{ reply: "one" }, { reply: "two" }])])

    const first = await agent.receiveAndWait(hello())
    const second = await agent.receiveAndWait(hello())

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.turn).toBeUndefined()
    // Nothing else happened: one inbox row, one turn, one reply.
    expect(await agent.store.inbox.count()).toBe(1)
    expect(await agent.store.turns.count()).toBe(1)
    expect(sender.texts()).toEqual(["one"])
  })

  test("LOOP-1: a duplicate arriving mid turn is still dropped", async () => {
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)])

    await agent.receive(hello())
    // The webhook retried while the first turn was still running. The
    // unique key decides, not a prior read, so there is nothing to race.
    const retry = await agent.receive(hello())

    expect(retry.duplicate).toBe(true)
    held.open()
    await agent.settled()

    expect(await agent.store.turns.count()).toBe(1)
    expect(sender.texts()).toEqual(["We open at 11."])
  })

  test("LOOP-1: two deliveries at the same instant make one turn", async () => {
    const agent = agentWith([scriptedBrain([{ reply: "one" }, { reply: "two" }])])

    const [a, b] = await Promise.all([agent.receive(hello()), agent.receive(hello())])
    await agent.settled()

    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true])
    expect(await agent.store.inbox.count()).toBe(1)
    expect(await agent.store.turns.count()).toBe(1)
  })

  test("API-1: a turn that fails does not fail receive", async () => {
    const problems: unknown[] = []
    sender = fakeSender()
    const broken: Brain = {
      id: "broken",
      kind: "api",
      supportsImages: false,
      // Not a BrainError: this stands for a bug in an adapter rather than
      // a provider outage. BRAIN-5 falls back on either, so with one
      // brain in the list the turn runs out of brains.
      complete: () => Promise.reject(new TypeError("undefined is not a function")),
    }
    const agent = createAgent({
      config: config(),
      deps: {
        decisionModel: scriptedDecisionModel([]),
        brains: [broken],
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: PROMPT,
      tools: [],
      onTurnError: (failure) => problems.push(failure.error),
    })

    // The webhook is answered either way.
    const result = await agent.receive(hello())
    expect(result.duplicate).toBe(false)
    await agent.settled()

    // BRAIN-5 handles this, so it is not an unplanned failure and
    // onTurnError is not called. The turn says it ran out of brains, and
    // the trace says which one failed and what it said.
    expect(problems).toEqual([])

    const fell = await agent.store.events.list({ name: "fallback_used" })
    expect(fell).toHaveLength(1)
    expect(JSON.stringify(fell[0]?.props)).toContain("undefined is not a function")
  })

  test("API-1: a failed turn is recorded as failed, not left pending", async () => {
    const broken: Brain = {
      id: "broken",
      kind: "api",
      supportsImages: false,
      complete: () => Promise.reject(new TypeError("boom")),
    }
    const agent = agentWith([broken])

    const result = await agent.receiveAndWait(hello())

    // BRAIN-5: any throw moves to the next brain, and there is no next
    // one, so the turn ran out rather than crashed.
    expect(result.turn?.outcome).toBe("brains_failed")

    // The inbox row says what happened to it, so a sweep can find it.
    const row = await agent.store.inbox.byId(result.inboxId)
    expect(row?.status).toBe("failed")
    const turn = (await agent.store.turns.list())[0]
    expect(turn?.outcome).toBe("brains_failed")
    expect(turn?.ended_at).not.toBeNull()
    // The person is told nothing rather than told a lie (LOOP-12 is T2.3).
    expect(sender.sent).toEqual([])
  })

  test("EVT-1: a turn that runs behind receive still writes its trace", async () => {
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)])

    await agent.receive(hello())
    held.open()
    await agent.settled()

    const names = (await agent.store.events.list({}, { orderBy: "seq" })).map((row) => row.name)
    expect(names).toEqual(["turn_started", "turn_ended"])
  })

  test("API-1: receive reports how much work is in flight", async () => {
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)])

    expect(agent.inFlight()).toBe(0)
    await agent.receive(hello())
    // The worker picks it up a moment after receive returns, which is the
    // whole point of API-1.
    await untilBusy(agent, 1)
    expect(agent.inFlight()).toBe(1)

    held.open()
    await agent.settled()
    expect(agent.inFlight()).toBe(0)
  })

  test("API-1: settled waits for every turn in flight, not just one", async () => {
    const held = gate()
    const agent = agentWith([gatedBrain(held.opened)])

    await agent.receive(hello({ channelUserId: "1", channelMessageId: "a" }))
    await agent.receive(hello({ channelUserId: "2", channelMessageId: "b" }))
    await untilBusy(agent, 2)
    expect(agent.inFlight()).toBe(2)

    held.open()
    await agent.settled()

    expect(agent.inFlight()).toBe(0)
    expect(sender.sent).toHaveLength(2)
  })
})
