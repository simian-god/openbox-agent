// DATA-4 and PRO-1: the job loop, and the recovery sweep.
//
// The sweep is the one that matters. It closes the last way a message can
// be lost outright: a process killed mid turn leaves the messages it had
// taken marked `merged`, and nothing else ever looks at those.
import { test, expect, beforeAll, beforeEach, afterEach } from "bun:test"
import { scriptedDecisionModel } from "../../src/testing/scripted-decision.ts"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { migrate } from "../../src/migrate/index.ts"
import {
  createAgent as buildAgent,
  replyKey,
  FREE,
  type Agent,
  type AgentOptions,
  type Deps,
} from "../../src/runtime/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { scriptedBrain } from "../../src/testing/scripted-brain.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { systemClock } from "../../src/testing/clock.ts"

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
    workerPollMs: 25,
    jobAttempts: 3,
    jobBackoffMs: 1,
    // Nothing waits in these tests: a lease that has expired is stale.
    recoverAfterSeconds: 0,
    ...over,
  })
}

describeDatabase("the job loop", (sql) => {
  let sender: FakeSender

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  /** An agent, not started: most of these tests drive the loop by hand. */
  function agentWith(over: Record<string, unknown> = {}): Agent {
    sender = fakeSender()
    const deps: Deps = {
      decisionModel: scriptedDecisionModel([]),
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

  /**
   * Waits for the row, not for the handler.
   *
   * A handler returning is not the job finishing: the status is written
   * after it returns, so reading the row the instant the handler ran is a
   * race that only shows up on a slow machine.
   */
  async function untilJobs(agent: Agent, status: string, count = 1): Promise<void> {
    while ((await agent.store.jobs.count({ status })) < count) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  /**
   * Waits for the thing a test actually asserts, with a bound.
   *
   * Waiting on a proxy and then sleeping is how the DATA-4 test below came
   * to fail once under a loaded suite and pass on a rerun. A bound rather
   * than an open loop, so a real break fails with the assertion rather
   * than hanging until the runner gives up.
   */
  async function until(what: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms
    while (!what() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  test("JOB-1: a queued job runs, and is recorded as having run", async () => {
    const agent = agentWith()
    const ran: string[] = []
    agent.jobs.on("say_hello", async (job) => {
      ran.push(String(job.payload["who"]))
    })

    agent.start()
    await agent.jobs.queue({ kind: "say_hello", payload: { who: "Asha" } })
    await untilJobs(agent, "done")

    expect(ran).toEqual(["Asha"])
    const row = (await agent.store.jobs.list())[0]
    expect(row?.status).toBe("done")
    expect(row?.attempts).toBe(1)
    expect(row?.last_run_at).not.toBeNull()

    const event = (await agent.store.events.list({ name: "job_ran" }))[0]
    expect(event?.props).toMatchObject({ job: "say_hello", ok: true, attempts: 1 })
  })

  test("PRO-1: the same dedupe key twice queues one job", async () => {
    const agent = agentWith()

    const once = await agent.jobs.queue({ kind: "remind", dedupeKey: "booking-7" })
    const twice = await agent.jobs.queue({
      kind: "remind",
      payload: { changed: true },
      dedupeKey: "booking-7",
    })

    expect(twice.id).toBe(once.id)
    expect(await agent.store.jobs.count()).toBe(1)
  })

  test("PRO-1: a job with no dedupe key can be queued as often as you like", async () => {
    const agent = agentWith()
    await agent.jobs.queue({ kind: "sweep" })
    await agent.jobs.queue({ kind: "sweep" })

    expect(await agent.store.jobs.count()).toBe(2)
  })

  test("JOB-1: a job is not run before it is due", async () => {
    const agent = agentWith()
    const ran: string[] = []
    agent.jobs.on("later", async () => {
      ran.push("x")
    })

    agent.start()
    await agent.jobs.queue({ kind: "later", runAt: new Date(Date.now() + 60_000) })
    await new Promise((r) => setTimeout(r, 150))

    expect(ran).toEqual([])
    expect((await agent.store.jobs.list())[0]?.status).toBe("queued")
  })

  test("JOB-2: a job that throws is tried again, and gets through", async () => {
    const agent = agentWith()
    let tries = 0
    agent.jobs.on("flaky", async () => {
      tries++
      if (tries === 1) throw new Error("not this time")
    })

    agent.start()
    await agent.jobs.queue({ kind: "flaky" })
    while ((await agent.store.jobs.count({ status: "done" })) === 0) {
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(tries).toBe(2)
    const row = (await agent.store.jobs.list())[0]
    expect(row?.status).toBe("done")
    expect(row?.attempts).toBe(2)
  })

  test("JOB-2: a job that keeps throwing fails after jobAttempts", async () => {
    const agent = agentWith()
    let tries = 0
    agent.jobs.on("broken", async () => {
      tries++
      throw new Error("always")
    })

    agent.start()
    await agent.jobs.queue({ kind: "broken" })
    while ((await agent.store.jobs.count({ status: "failed" })) === 0) {
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(tries).toBe(3)
    const row = (await agent.store.jobs.list())[0]
    expect(row?.attempts).toBe(3)
    expect(row?.error).toContain("always")
  })

  test("JOB-2: a job nobody can run fails at once, since waiting would not help", async () => {
    const agent = agentWith()
    agent.start()
    await agent.jobs.queue({ kind: "nobody_handles_this" })
    while ((await agent.store.jobs.count({ status: "failed" })) === 0) {
      await new Promise((r) => setTimeout(r, 5))
    }

    const row = (await agent.store.jobs.list())[0]
    expect(row?.attempts).toBe(1)
    expect(row?.error).toContain("no handler")
  })

  test("DATA-4: of two processes, one runs the job", async () => {
    const first = agentWith()
    const second = agentWith()
    const ran: string[] = []
    first.jobs.on("once", async () => {
      ran.push("first")
    })
    second.jobs.on("once", async () => {
      ran.push("second")
    })

    await first.jobs.queue({ kind: "once", dedupeKey: "k" })
    first.start()
    second.start()
    // Wait for the run itself, not for a row that says one happened.
    await until(() => ran.length > 0)
    // Then give the other process long enough to run it as well, which is
    // the thing this test exists to prove it cannot.
    await new Promise((r) => setTimeout(r, 150))

    expect(ran).toHaveLength(1)
    expect(await agent_count(first, "done")).toBe(1)
  })

  test("JOB-1: a job a dead process claimed is taken over", async () => {
    const agent = agentWith()
    const ran: string[] = []
    agent.jobs.on("abandoned", async () => {
      ran.push("x")
    })

    // Exactly what a process killed mid job leaves behind: running, with
    // a lease that has since expired.
    const job = await agent.jobs.queue({ kind: "abandoned" })
    await agent.store.jobs.update(
      { id: job.id },
      { status: "running", lease_owner: "a process that is gone", lease_expires_at: FREE },
    )

    agent.start()
    await untilJobs(agent, "done")

    expect(ran).toEqual(["x"])
    const row = await agent.store.jobs.byId(job.id)
    expect(row?.status).toBe("done")
    expect(row?.lease_owner).toBeNull()
  })

  test("DATA-4: two processes cannot both take over the same abandoned job", async () => {
    // The candidates list filters by the expired lease, but two processes
    // reading it at the same moment both see the same job. What stops them
    // both running it is the conditional update, so that is what this
    // tests: without it the handler runs twice.
    const first = agentWith()
    const second = agentWith()
    const ran: string[] = []
    first.jobs.on("abandoned", async () => {
      ran.push("first")
      await new Promise((r) => setTimeout(r, 40))
    })
    second.jobs.on("abandoned", async () => {
      ran.push("second")
      await new Promise((r) => setTimeout(r, 40))
    })

    const job = await first.jobs.queue({ kind: "abandoned" })
    await first.store.jobs.update(
      { id: job.id },
      { status: "running", lease_owner: "a process that is gone", lease_expires_at: FREE },
    )

    first.start()
    second.start()
    await untilJobs(first, "done")
    await new Promise((r) => setTimeout(r, 150))

    expect(ran).toHaveLength(1)
  })

  test("JOB-1: a job someone is still running is left alone", async () => {
    const agent = agentWith()
    const ran: string[] = []
    agent.jobs.on("busy", async () => {
      ran.push("x")
    })

    const job = await agent.jobs.queue({ kind: "busy" })
    await agent.store.jobs.update(
      { id: job.id },
      {
        status: "running",
        lease_owner: "someone else",
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    )

    agent.start()
    await new Promise((r) => setTimeout(r, 150))

    expect(ran).toEqual([])
    expect((await agent.store.jobs.byId(job.id))?.lease_owner).toBe("someone else")
  })
})

/** How many of this agent's jobs are in a status. */
async function agent_count(agent: Agent, status: string): Promise<number> {
  return agent.store.jobs.count({ status })
}

describeDatabase("the recovery sweep", (sql) => {
  let sender: FakeSender

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  function agentWith(over: Record<string, unknown> = {}): Agent {
    sender = fakeSender()
    const deps: Deps = {
      decisionModel: scriptedDecisionModel([]),
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

  /**
   * A process killed mid turn: the message was taken into a turn, so it is
   * `merged`, and the lease it was taken under has expired because nothing
   * is renewing it any more.
   */
  async function abandon(agent: Agent): Promise<string> {
    const written = await agent.receive(hello())
    const person = await agent.store.people.find({})
    await agent.store.inbox.update({ id: written.inboxId }, { status: "merged" })
    await agent.store.leases.update(
      { person_id: person?.id ?? "" },
      { owner: "a process that is gone", expires_at: FREE },
    )
    return written.inboxId
  }

  test("JOB-3: a message a dead process took is handed back and answered", async () => {
    const agent = agentWith()
    const inboxId = await abandon(agent)

    // Nothing else would ever look at that row: another worker takes the
    // person over once the lease expires, but only looks for `pending`.
    expect(await agent.jobs.recover()).toBe(1)
    expect((await agent.store.inbox.byId(inboxId))?.status).toBe("pending")

    agent.start()
    await agent.settled()
    expect(sender.texts()).toEqual(["We open at 11."])
    expect((await agent.store.inbox.byId(inboxId))?.status).toBe("done")
  })

  test("JOB-3: the sweep runs on the loop's own cadence, with nothing to set up", async () => {
    const agent = agentWith()
    await abandon(agent)

    // No job queued, no handler registered: starting the agent is enough.
    // `settled` cannot be the wait here, because it asks what is left to
    // do and a message still marked merged does not look like work to it
    // until the sweep has handed it back.
    agent.start()
    while ((await agent.store.inbox.count({ status: "done" })) === 0) {
      await new Promise((r) => setTimeout(r, 5))
    }
    await agent.settled()

    expect(sender.texts()).toEqual(["We open at 11."])
  })

  test("JOB-3: it is recorded, so a trace says a turn was abandoned", async () => {
    const agent = agentWith()
    await abandon(agent)
    await agent.jobs.recover()

    const event = (await agent.store.events.list({ name: "job_ran" }))[0]
    expect(event?.props).toMatchObject({ job: "recover_turns", ok: true, messages: 1 })
    expect(String(event?.props["why"])).toContain("abandoned")
  })

  test("JOB-3: a person somebody is still handling is left alone", async () => {
    const agent = agentWith()
    const written = await agent.receive(hello())
    const person = await agent.store.people.find({})
    await agent.store.inbox.update({ id: written.inboxId }, { status: "merged" })
    // The lease is live, so the turn is running, not abandoned.
    await agent.store.leases.update(
      { person_id: person?.id ?? "" },
      { owner: "still going", expires_at: new Date(Date.now() + 60_000).toISOString() },
    )

    expect(await agent.jobs.recover()).toBe(0)
    expect((await agent.store.inbox.byId(written.inboxId))?.status).toBe("merged")
  })

  test("JOB-3: a lease that expired only moments ago waits out the margin", async () => {
    // The margin is for a process that stalled rather than died: taking
    // its messages back would answer the person twice.
    const agent = agentWith({ recoverAfterSeconds: 300 })
    const written = await agent.receive(hello())
    const person = await agent.store.people.find({})
    await agent.store.inbox.update({ id: written.inboxId }, { status: "merged" })
    await agent.store.leases.update(
      { person_id: person?.id ?? "" },
      { owner: "stalled", expires_at: new Date(Date.now() - 1_000).toISOString() },
    )

    expect(await agent.jobs.recover()).toBe(0)
  })

  test("JOB-3: a message still waiting is not touched by the sweep", async () => {
    const agent = agentWith()
    const written = await agent.receive(hello())

    expect(await agent.jobs.recover()).toBe(0)
    expect((await agent.store.inbox.byId(written.inboxId))?.status).toBe("pending")
  })

  test("JOB-4: the answer goes out once, even if the first turn also replied", async () => {
    // The reply is keyed by the messages it answers, not by the turn, so
    // the turn that picks up an abandoned message cannot say the same
    // thing a second time.
    const agent = agentWith()
    const inboxId = await abandon(agent)
    const person = await agent.store.people.find({})

    // What the process that died had already queued before it stopped.
    await agent.outbox.queue({
      personId: person?.id ?? "",
      kind: "reply",
      channel: "whatsapp",
      channelUserId: "42",
      text: "We open at 11.",
      idempotencyKey: replyKey([inboxId]),
    })

    agent.start()
    while ((await agent.store.inbox.count({ status: "done" })) === 0) {
      await new Promise((r) => setTimeout(r, 5))
    }
    await agent.settled()

    expect(await agent.store.outbox.count()).toBe(1)
    expect(sender.texts()).toEqual(["We open at 11."])
  })
})

test("JOB-4: replyKey depends on what is answered, not the order it is listed", () => {
  expect(replyKey(["a", "b"])).toBe(replyKey(["b", "a"]))
  expect(replyKey(["a"])).not.toBe(replyKey(["a", "b"]))
  expect(replyKey(["a"])).toMatch(/^reply:[0-9a-f]{32}$/)
})
