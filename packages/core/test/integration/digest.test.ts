// LEARN-3 on a real agent and a real database: the job is booked, it
// reads the right week, it goes to the builder's channel, and it books
// the next one.
import { test, expect, beforeEach } from "bun:test"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import type { Agent, AgentOptions } from "../../src/runtime/index.ts"
import { DIGEST_JOB, digestKey, nextDigestAt } from "../../src/runtime/digest.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool } from "../../src/tools/index.ts"
import { scriptedBrain } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import { z } from "zod"

const agents = trackAgents("digest.test.ts")
const SECRET = "test-secret"
const BUILDER = { channel: "telegram", channelUserId: "builder-1" }

const table = defineTool({
  name: "check_availability",
  description: "Checks whether a table is free.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask about a table"], dontCallWhen: ["they do not"] },
  examples: { should: ["any space?"], shouldNot: ["hello"] },
  handler: async () => ({ free: true }),
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
    builderChannel: BUILDER,
    ...over,
  })
}

describeDatabase("LEARN-3: the weekly digest", (sql) => {
  // A Wednesday, so the next digest is a Monday away.
  const clock = fixedClock("2026-10-28T00:00:00Z")
  let sender: FakeSender

  beforeEach(async () => {
    await resetDatabase(sql())
    clock.set("2026-10-28T00:00:00Z")
  })

  function build(over: Record<string, unknown> = {}): Agent {
    sender = fakeSender()
    const made: AgentOptions = {
      secret: SECRET,
      config: config(over),
      deps: {
        brains: [scriptedBrain([{ reply: "Hello." }])],
        decisionModel: scriptedDecisionModel([]),
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: "You are the host at a restaurant.",
      tools: [table],
    }
    return agents.create(made)
  }

  /** A flag for somebody, written at a given instant. */
  async function flag(agent: Agent, kind: string, at: string, personId: string): Promise<void> {
    await agent.store.flags.insert({
      person_id: personId,
      kind,
      detail: {},
      created_at: at,
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

  /** The digest job, run by hand so a test does not wait a week. */
  async function runDigest(agent: Agent, dueAt: string): Promise<void> {
    const job = await agent.store.jobs.insert({
      kind: DIGEST_JOB,
      payload: { dueAt },
      status: "queued",
      run_at: dueAt,
    })
    await agent.jobs.run(job)
  }

  test("LEARN-3: starting books the next digest, on the right Monday at nine", async () => {
    const agent = build()

    agent.start()
    await agent.settled()

    const [job] = await agent.store.jobs.list({ kind: DIGEST_JOB }, { orderBy: "seq" })
    expect(job).toBeDefined()
    // 2026-11-02 is the next Monday. 09:00 in Kolkata is 03:30 UTC.
    expect(job?.run_at.startsWith("2026-11-02T03:30:00")).toBe(true)
    expect(job?.payload["dueAt"]).toBe("2026-11-02T03:30:00.000Z")
  })

  test("LEARN-3: starting twice books one digest, not two", async () => {
    // PRO-1's dedupe key, which is what makes seeding at every start safe.
    const agent = build()

    agent.start()
    await agent.settled()
    agent.start()
    await agent.settled()

    expect(await agent.store.jobs.count({ kind: DIGEST_JOB })).toBe(1)
  })

  test("LEARN-3: the digest goes to the builder's channel", async () => {
    const agent = build()
    const riya = await someone(agent, "Riya")
    await flag(agent, "handover", "2026-10-28T09:00:00Z", riya)

    await runDigest(agent, "2026-11-02T03:30:00.000Z")

    const sent = sender.sent.filter((out) => out.channelUserId === BUILDER.channelUserId)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.channel).toBe("telegram")
    expect(sent[0]?.text).toContain("handover")
  })

  test("LEARN-3: flag counts by kind, compared with the week before", async () => {
    const agent = build()
    const riya = await someone(agent, "Riya")

    // Two handovers this week, one the week before.
    await flag(agent, "handover", "2026-10-27T09:00:00Z", riya)
    await flag(agent, "handover", "2026-10-28T09:00:00Z", riya)
    await flag(agent, "handover", "2026-10-20T09:00:00Z", riya)

    await runDigest(agent, "2026-11-02T03:30:00.000Z")

    const text = sender.sent.at(-1)?.text ?? ""
    expect(text).toContain("handover: 2 (up from 1)")
  })

  test("LEARN-3: a flag older than the two weeks counts in neither", async () => {
    const agent = build()
    const riya = await someone(agent, "Riya")
    await flag(agent, "handover", "2026-10-28T09:00:00Z", riya)
    // A month ago, which is outside both windows.
    await flag(agent, "gate_block", "2026-09-28T09:00:00Z", riya)

    await runDigest(agent, "2026-11-02T03:30:00.000Z")

    const text = sender.sent.at(-1)?.text ?? ""
    expect(text).toContain("handover")
    expect(text).not.toContain("gate_block")
  })

  test("LEARN-3: the five worst conversations, and no more than five", async () => {
    const agent = build()
    // Six people, with descending flag counts, so the sixth must be cut.
    for (let at = 6; at >= 1; at--) {
      const who = await someone(agent, `person-${at}`)
      for (let n = 0; n < at; n++) {
        await flag(agent, "gate_block", "2026-10-28T09:00:00Z", who)
      }
    }

    await runDigest(agent, "2026-11-02T03:30:00.000Z")

    const text = sender.sent.at(-1)?.text ?? ""
    expect(text).toContain("person-6: 6")
    expect(text).toContain("person-2: 2")
    // Seven flags would be the most flagged; one flag is the least, and
    // LEARN-3 asks for five.
    expect(text).not.toContain("person-1: 1")
  })

  test("LEARN-3: spend and median latency come from the week's turns", async () => {
    const agent = build()
    const riya = await someone(agent, "Riya")
    for (const [latency, cost] of [
      [1000, 0.01],
      [3000, 0.02],
      [2000, 0.03],
    ]) {
      await agent.store.turns.insert({
        person_id: riya,
        brains: ["scripted"],
        steps: 1,
        cost_usd: cost,
        latency_ms: latency,
        outcome: "replied",
        started_at: "2026-10-28T09:00:00Z",
      })
    }

    await runDigest(agent, "2026-11-02T03:30:00.000Z")

    const text = sender.sent.at(-1)?.text ?? ""
    expect(text).toContain("3 turns")
    expect(text).toContain("$0.06")
    // The middle of 1000, 2000 and 3000. The mean is the same number
    // here, so this does not tell a median from a mean: the unit test on
    // `median` is what does, with values where they differ.
    expect(text).toContain("2000ms")
  })

  test("LEARN-3: sending it books the next week's digest", async () => {
    const agent = build()

    await runDigest(agent, "2026-11-02T03:30:00.000Z")

    const booked = await agent.store.jobs.list({ kind: DIGEST_JOB }, { orderBy: "seq" })
    const runAt = booked.map((job) => job.payload["dueAt"])
    expect(runAt).toContain("2026-11-09T03:30:00.000Z")
  })

  // The builder's choice: a week the agent was down for goes out late
  // rather than being lost, covering the week it was due for.
  test("LEARN-3: a digest that runs late covers the week it was due for", async () => {
    const agent = build()
    const riya = await someone(agent, "Riya")
    // Inside the week ending Monday 2026-11-02.
    await flag(agent, "handover", "2026-10-28T09:00:00Z", riya)
    // After that Monday, so it belongs to the following digest.
    await flag(agent, "gate_block", "2026-11-03T09:00:00Z", riya)

    // The agent was off until Wednesday.
    clock.set("2026-11-04T10:00:00Z")
    await runDigest(agent, "2026-11-02T03:30:00.000Z")

    const text = sender.sent.at(-1)?.text ?? ""
    expect(text).toContain("2026-10-26")
    expect(text).toContain("handover")
    expect(text).not.toContain("gate_block")
  })

  test("LEARN-3: a quiet week still goes out, so silence is reported too", async () => {
    const agent = build()

    await runDigest(agent, "2026-11-02T03:30:00.000Z")

    const text = sender.sent.at(-1)?.text ?? ""
    expect(text.toLowerCase()).toContain("nothing happened")
  })

  test("LEARN-3: one agent never counts another's flags", async () => {
    const agent = build()
    const other = agents.create({
      secret: SECRET,
      config: config({ name: "dentist" }),
      deps: {
        brains: [scriptedBrain([{ reply: "Hello." }])],
        decisionModel: scriptedDecisionModel([]),
        db: localSupabase(),
        sender: fakeSender(),
        clock,
      },
      prompt: "You are a dentist.",
      tools: [table],
    })
    const theirs = await someone(other, "Someone")
    await flag(other, "handover", "2026-10-28T09:00:00Z", theirs)

    await runDigest(agent, "2026-11-02T03:30:00.000Z")

    const text = sender.sent.at(-1)?.text ?? ""
    expect(text.toLowerCase()).toContain("nothing happened")
  })

  test("LEARN-3: a send the channel refuses fails the job, so it is tried again", async () => {
    sender = fakeSender()
    const refusing = fakeSender({
      respond: () => ({ status: "rejected", retryable: true, error: "telegram said no" }),
    })
    const agent = agents.create({
      secret: SECRET,
      config: config(),
      deps: {
        brains: [scriptedBrain([{ reply: "Hello." }])],
        decisionModel: scriptedDecisionModel([]),
        db: localSupabase(),
        sender: refusing,
        clock,
      },
      prompt: "You are the host at a restaurant.",
      tools: [table],
    })

    const job = await agent.store.jobs.insert({
      kind: DIGEST_JOB,
      payload: { dueAt: "2026-11-02T03:30:00.000Z" },
      status: "queued",
      run_at: "2026-11-02T03:30:00.000Z",
    })
    const ran = await agent.jobs.run(job)

    // Queued again rather than done, which is how the job loop retries.
    expect(ran.status).toBe("queued")
    expect(String(ran.error)).toContain("telegram said no")
    // And the next week was not booked over the failure.
    const booked = await agent.store.jobs.list({ kind: DIGEST_JOB }, { orderBy: "seq" })
    expect(booked.map((one) => one.payload["dueAt"])).not.toContain("2026-11-09T03:30:00.000Z")
  })

  test("LEARN-3: the same week is never sent twice, whatever retries happen", async () => {
    const agent = build()

    await runDigest(agent, "2026-11-02T03:30:00.000Z")
    await runDigest(agent, "2026-11-02T03:30:00.000Z")

    const keys = sender.sent.map((out) => out.idempotencyKey)
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe(digestKey(new Date("2026-11-02T03:30:00.000Z")))
  })
})

describeDatabase("LEARN-3: an agent with no builder channel", (sql) => {
  const clock = fixedClock("2026-10-28T00:00:00Z")

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  function build(): Agent {
    return agents.create({
      secret: SECRET,
      config: config({ builderChannel: undefined }),
      deps: {
        brains: [scriptedBrain([{ reply: "Hello." }])],
        decisionModel: scriptedDecisionModel([]),
        db: localSupabase(),
        sender: fakeSender(),
        clock,
      },
      prompt: "You are the host at a restaurant.",
      tools: [table],
    })
  }

  // The builder's choice: no channel is no digest, and it is said rather
  // than refused or passed over in silence.
  test("LEARN-3: it still starts, and says why no digest will come", () => {
    const agent = build()

    expect(agent.notices.join(" ")).toContain("builderChannel")
    expect(agent.notices.join(" ")).toContain("digest")
  })

  test("LEARN-3: nothing is booked, since there is nowhere to send it", async () => {
    const agent = build()

    agent.start()
    await agent.settled()

    expect(await agent.store.jobs.count({ kind: DIGEST_JOB })).toBe(0)
  })

  test("LEARN-3: an agent with a channel says nothing about it", () => {
    const agent = agents.create({
      secret: SECRET,
      config: config(),
      deps: {
        brains: [scriptedBrain([{ reply: "Hello." }])],
        decisionModel: scriptedDecisionModel([]),
        db: localSupabase(),
        sender: fakeSender(),
        clock,
      },
      prompt: "You are the host at a restaurant.",
      tools: [table],
    })

    expect(agent.notices).toEqual([])
  })
})

describeDatabase("LEARN-3: the digest on the job loop", (sql) => {
  const clock = fixedClock("2026-10-28T00:00:00Z")

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  test("LEARN-3: the loop runs it when its Monday comes, with nobody asking", async () => {
    const sender = fakeSender()
    const agent = agents.create({
      secret: SECRET,
      config: config(),
      deps: {
        brains: [scriptedBrain([{ reply: "Hello." }])],
        decisionModel: scriptedDecisionModel([]),
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: "You are the host at a restaurant.",
      tools: [table],
    })

    agent.start()
    await agent.settled()
    const due = nextDigestAt(new Date("2026-10-28T00:00:00Z"), config())

    // The clock reaches the Monday, and the loop picks the job up on its
    // own rather than a test calling the handler. Waited for rather than
    // settled on, because the pump looks for due jobs on its own cadence
    // and nothing is in flight until it does.
    clock.set(new Date(due.getTime() + 1000).toISOString())
    const deadline = Date.now() + 5000
    while (sender.sent.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await agent.settled()

    const sent = sender.sent.filter((out) => out.channelUserId === BUILDER.channelUserId)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain("Weekly digest")
  })
})
