// PRO-1 and PRO-2: the agent speaking first.
//
// Everything else in the core answers a message. These two do not, and
// that changes what can go wrong. A reply that is sent twice is annoying;
// a reminder that is sent twice at six in the morning is the kind of thing
// a person blocks an agent over. So the tests here are written around
// three questions:
//
//   does it survive a restart (C16, and the whole reason it is a job)
//   does it go out exactly once, however many times the job runs
//   who does it not go out to at all
//
// The send rules in PRO-3, which are quiet hours, the opt out and the
// channel window, are T7.2. What is here is the two ways a proactive
// message is made and the three reasons one is dropped.
import { test, expect, describe, beforeAll, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { migrate } from "../../src/migrate/index.ts"
import { type Agent, type AgentOptions } from "../../src/runtime/index.ts"
import { PROACTIVE_JOB } from "../../src/runtime/proactive.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool, type Tool } from "../../src/tools/index.ts"
import {
  scriptedBrain,
  type ScriptedBrain,
  type ScriptedStep,
} from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { WANTS_HUMAN } from "../../src/runtime/handover.ts"
import type { JobRow, PersonRow } from "../../src/store/index.ts"

const SECRET = "test-secret-long-enough-to-look-real"
const PROMPT = "You are the host at a restaurant."

const agents = trackAgents("proactive.test.ts")

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
    ...over,
  })
}

/** What actually ran, so a test can tell a record from a consequence. */
let charged: { size: number }[] = []

const bookTable = defineTool({
  name: "book_table",
  description: "Books a table, which cannot be undone.",
  input: z.object({ size: z.number().int().min(1) }),
  risk: "irreversible",
  roles: ["end_user"],
  conditions: {
    callWhen: ["The person has agreed to a table for a known number of people"],
    dontCallWhen: ["The person is only asking whether a table is free"],
  },
  confirmSummary: (args) => `Table for ${args.size} on Friday at 20:00`,
  examples: { should: ["book it for four"], shouldNot: ["any space friday?"] },
  handler: async (args) => {
    charged.push({ size: args.size })
    return { booked: true, size: args.size }
  },
})

describeDatabase("proactive messages", (sql) => {
  const clock = fixedClock("2026-10-19T06:00:00Z")
  let sender: FakeSender

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
    charged = []
  })

  interface Built {
    agent: Agent
    brain: ScriptedBrain
  }

  /** An agent nobody has started, since most of these drive a job by hand. */
  function agentWith(
    script: ScriptedStep[] = [{ reply: "Your table is at 8." }],
    options: { tools?: Tool[]; gate?: number; start?: boolean } = {},
  ): Built {
    const brain = scriptedBrain(script, { exhaustedReply: "Anything else?" })
    sender = fakeSender()
    const build: AgentOptions = {
      config: config(),
      deps: {
        brains: [brain],
        decisionModel: scriptedDecisionModel([
          {
            [WANTS_HUMAN]: yesno(0),
            [GATE_QUESTION]: yesno(options.gate ?? 1),
          },
        ]),
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: PROMPT,
      tools: options.tools ?? [],
      secret: SECRET,
    }
    const agent = options.start === true ? agents.create(build) : agents.build(build)
    return { agent, brain }
  }

  /** Somebody the glue code knows about, who has not written today. */
  const person = (agent: Agent, id = "9", name = "Asha"): Promise<PersonRow> =>
    agent.store.people.insert({
      channel: "whatsapp",
      channel_user_id: id,
      display_name: name,
    })

  /** The one job a schedule or a trigger wrote. */
  async function jobOf(agent: Agent): Promise<JobRow> {
    const [job] = await agent.store.jobs.list({ kind: PROACTIVE_JOB }, { orderBy: "run_at" })
    if (job === undefined) throw new Error("no proactive job was written")
    return job
  }

  /**
   * The proactive handler's own `job_ran`, which carries `did`.
   *
   * The job loop records one of its own after the handler returns, so
   * these are picked out by what they say rather than by being first.
   */
  async function ranProactively(agent: Agent): Promise<{ props: Record<string, unknown> }> {
    const rows = await agent.store.events.list({ name: "job_ran" }, { orderBy: "seq" })
    const mine = rows.filter((row) => "did" in row.props)
    if (mine.length !== 1) {
      throw new Error(`expected one proactive job_ran, found ${mine.length}`)
    }
    return mine[0] as { props: Record<string, unknown> }
  }

  /** Waits for the thing a test asserts, with a bound rather than a sleep. */
  async function until(what: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms
    while (!what() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  describe("PRO-1: a scheduled message is a job", () => {
    test("PRO-1: a scheduled message is written as a job and sent when it is due", async () => {
      const { agent } = agentWith()
      const who = await person(agent)

      const scheduled = await agent.schedule({
        personId: who.id,
        at: clock.now(),
        text: "Your table is at 8 tonight.",
      })

      const job = await jobOf(agent)
      expect(job.id).toBe(scheduled.jobId)
      expect(job.status).toBe("queued")
      expect(scheduled.duplicate).toBe(false)

      agent.start()
      await until(() => sender.texts().length > 0)

      expect(sender.texts()).toEqual(["Your table is at 8 tonight."])
      const [row] = await agent.store.outbox.list()
      // PRO-4 rests on this: a proactive message is a different kind from
      // a reply, which is what quiet hours and the opt out read in T7.2.
      expect(row?.kind).toBe("proactive")
      expect(row?.status).toBe("sent")
    })

    test("PRO-1: nothing goes out before its time", async () => {
      const { agent } = agentWith()
      const who = await person(agent)

      await agent.schedule({
        personId: who.id,
        at: new Date(clock.now().getTime() + 60 * 60 * 1000),
        text: "Your table is at 8 tonight.",
      })

      agent.start()
      await agent.settled()

      expect(sender.texts()).toEqual([])
      expect((await jobOf(agent)).status).toBe("queued")
    })

    test("PRO-1: the same dedupe key twice schedules one message", async () => {
      const { agent } = agentWith()
      const who = await person(agent)

      const once = await agent.schedule({
        personId: who.id,
        at: clock.now(),
        text: "Your table is at 8 tonight.",
        dedupeKey: "booking-7-reminder",
      })
      const twice = await agent.schedule({
        personId: who.id,
        at: clock.now(),
        text: "A different reminder for the same booking.",
        dedupeKey: "booking-7-reminder",
      })

      expect(twice.jobId).toBe(once.jobId)
      expect(twice.duplicate).toBe(true)
      expect(await agent.store.jobs.count({ kind: PROACTIVE_JOB })).toBe(1)

      agent.start()
      await until(() => sender.texts().length > 0)
      await agent.settled()

      // The first one's words, once. A second schedule is a no op, not an
      // amendment: PRO-1 says the same key is the same reminder.
      expect(sender.texts()).toEqual(["Your table is at 8 tonight."])
    })

    test("PRO-1: a scheduled message survives a restart", async () => {
      // C16's first clause. The process that scheduled it never runs it.
      const { agent } = agentWith()
      const who = await person(agent)
      await agent.schedule({ personId: who.id, at: clock.now(), text: "Table at 8." })
      await agent.stop()

      const second = agentWith()
      second.agent.start()
      await until(() => sender.texts().length > 0)

      expect(sender.texts()).toEqual(["Table at 8."])
    })

    test("PRO-1: a job that runs twice sends once", async () => {
      // C16's second clause, and the reason the outbox key is the job's
      // id. A process that dies after sending leaves the job looking
      // unfinished, and another one takes it over (JOB-1).
      const { agent } = agentWith()
      const who = await person(agent)
      await agent.schedule({ personId: who.id, at: clock.now(), text: "Table at 8." })

      const job = await jobOf(agent)
      await agent.jobs.run(job)
      await agent.jobs.run(job)

      expect(await agent.store.outbox.count()).toBe(1)
      // And one line in the conversation. A second row here would be a
      // message the brain thinks it sent and the person never saw.
      expect(await agent.store.messages.count({ person_id: who.id })).toBe(1)

      agent.start()
      await until(() => sender.texts().length > 0)
      await agent.settled()

      expect(sender.texts()).toEqual(["Table at 8."])
    })

    test("PRO-1: a composed job that runs twice composes once", async () => {
      // The same guarantee where it costs something. A second run would
      // pay for another brain call and write a second message into the
      // conversation that the person never saw.
      const { agent, brain } = agentWith([{ reply: "Your table is at 8 tonight." }])
      const who = await person(agent)
      await agent.schedule({ personId: who.id, at: clock.now(), compose: "remind them" })

      const job = await jobOf(agent)
      await agent.jobs.run(job)
      await agent.jobs.run(job)

      expect(brain.calls).toHaveLength(1)
      expect(await agent.store.turns.count()).toBe(1)
      expect(await agent.store.outbox.count()).toBe(1)
      // The note and the message it produced, one each.
      expect(await agent.store.messages.count({ person_id: who.id })).toBe(2)
    })

    test("PRO-1: a reminder for somebody who is not in the database is refused", async () => {
      const { agent } = agentWith()

      await expect(
        agent.schedule({
          personId: "00000000-0000-4000-8000-000000000000",
          at: clock.now(),
          text: "Table at 8.",
        }),
      ).rejects.toThrow(/no person/i)

      expect(await agent.store.jobs.count()).toBe(0)
    })

    test("PRO-2: a scheduled message needs exactly one of text, template or compose", async () => {
      const { agent } = agentWith()
      const who = await person(agent)

      await expect(agent.schedule({ personId: who.id, at: clock.now() })).rejects.toThrow(
        /text, template or compose/i,
      )
      await expect(
        agent.schedule({
          personId: who.id,
          at: clock.now(),
          text: "Table at 8.",
          compose: "remind them about the table",
        }),
      ).rejects.toThrow(/text, template or compose/i)

      expect(await agent.store.jobs.count()).toBe(0)
    })
  })

  describe("PRO-2: fixed or composed", () => {
    test("PRO-2: a fixed message is sent word for word, with no brain call", async () => {
      const { agent, brain } = agentWith()
      const who = await person(agent)

      await agent.schedule({
        personId: who.id,
        at: clock.now(),
        text: "Your table is at 8 tonight.",
        urgent: true,
      })
      agent.start()
      await until(() => sender.texts().length > 0)

      expect(sender.texts()).toEqual(["Your table is at 8 tonight."])
      // A fixed message is the builder's words. Nothing reads them, nothing
      // improves them, and nothing is spent on them.
      expect(brain.calls).toHaveLength(0)
      expect(await agent.store.turns.count()).toBe(0)
      expect((await agent.store.outbox.list())[0]?.urgent).toBe(true)
    })

    test("PRO-2: a fixed message is stored, so the brain sees it next turn", async () => {
      const { agent } = agentWith()
      const who = await person(agent)

      await agent.schedule({ personId: who.id, at: clock.now(), text: "Table at 8." })
      agent.start()
      await until(() => sender.texts().length > 0)

      const [message] = await agent.store.messages.list({ person_id: who.id })
      expect(message?.text).toBe("Table at 8.")
      expect(message?.direction).toBe("outbound")
      expect(message?.author).toBe("agent")
    })

    test("PRO-2: a template goes out as a template", async () => {
      const { agent, brain } = agentWith()
      const who = await person(agent)

      await agent.schedule({
        personId: who.id,
        at: clock.now(),
        template: { name: "table_reminder", vars: { time: "20:00" } },
      })
      agent.start()
      await until(() => sender.sent.length > 0)

      expect(sender.sent[0]?.template).toEqual({ name: "table_reminder", vars: { time: "20:00" } })
      expect(brain.calls).toHaveLength(0)
      // Stored as something a brain reading the history can understand,
      // because a template it cannot see is a message it will repeat.
      const [message] = await agent.store.messages.list({ person_id: who.id })
      expect(message?.text).toContain("table_reminder")
      expect(message?.text).toContain("20:00")
    })

    test("PRO-2: a composed message is written by the brain, from a note about the event", async () => {
      const { agent, brain } = agentWith([{ reply: "Your table is at 8 tonight, see you then." }])
      const who = await person(agent)

      await agent.schedule({
        personId: who.id,
        at: clock.now(),
        compose: "remind them their table is at 8 tonight",
      })
      agent.start()
      await until(() => sender.texts().length > 0)

      expect(sender.texts()).toEqual(["Your table is at 8 tonight, see you then."])

      // The brain was told what to write about, as a notice rather than as
      // a message from the person: nobody wrote to the agent here.
      const [call] = brain.calls
      const notices = (call?.messages ?? []).filter((message) => message.role === "notice")
      expect(notices).toHaveLength(1)
      expect(JSON.stringify(notices)).toContain("remind them their table is at 8 tonight")
      expect((call?.messages ?? []).filter((message) => message.role === "person")).toHaveLength(0)

      // A real turn, so everything a turn records is there to read.
      const [turn] = await agent.store.turns.list()
      expect(turn?.outcome).toBe("replied")
      const started = await agent.store.events.find({ name: "turn_started" })
      expect(started?.props).toMatchObject({ proactive: true })
    })

    test("PRO-2: the note and the message are both stored, in that order", async () => {
      const { agent } = agentWith([{ reply: "Your table is at 8 tonight." }])
      const who = await person(agent)

      await agent.schedule({ personId: who.id, at: clock.now(), compose: "remind them" })
      agent.start()
      await until(() => sender.texts().length > 0)

      const rows = await agent.store.messages.list({ person_id: who.id }, { orderBy: "seq" })
      expect(rows.map((row) => row.author)).toEqual(["notice", "agent"])
      expect(rows[1]?.text).toBe("Your table is at 8 tonight.")
    })

    test("PRO-2: a composed turn is not asked whether the person wants a human", async () => {
      // HAND-1 reads that from what the person just said, and the person
      // has not said anything. Asking would be a question about nothing,
      // paid for per turn.
      const { agent } = agentWith([{ reply: "Your table is at 8 tonight." }])
      const who = await person(agent)

      await agent.schedule({ personId: who.id, at: clock.now(), compose: "remind them" })
      agent.start()
      await until(() => sender.texts().length > 0)

      expect(await agent.store.decisions.count({ kind: "wants_human" })).toBe(0)
      expect(await agent.store.handovers.count()).toBe(0)
    })

    test("PRO-2: a composed message runs through the same gate and confirmation", async () => {
      // PRO-2 says the same tools and gates, which is the clause that
      // keeps a reminder from becoming a way around CONF-1.
      const { agent } = agentWith(
        [{ tool: "book_table", input: { size: 4 } }, { reply: "Shall I book it?" }],
        { tools: [bookTable] },
      )
      const who = await person(agent)

      await agent.schedule({
        personId: who.id,
        at: clock.now(),
        compose: "ask whether they want their usual table tonight",
      })
      agent.start()
      await until(() => sender.texts().length > 0)
      await agent.settled()

      expect(charged).toEqual([])
      const [action] = await agent.store.pendingActions.list()
      expect(action?.tool).toBe("book_table")
      expect(action?.status).toBe("pending")
    })

    test("PRO-2: a brain with nothing to say sends nothing", async () => {
      const { agent } = agentWith([
        { output: { text: "", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } } },
      ])
      const who = await person(agent)

      await agent.schedule({ personId: who.id, at: clock.now(), compose: "remind them" })
      const job = await jobOf(agent)
      await agent.jobs.run(job)

      expect(sender.texts()).toEqual([])
      expect(await agent.store.outbox.count()).toBe(0)
      const ran = await ranProactively(agent)
      expect(ran.props).toMatchObject({ job: PROACTIVE_JOB, did: "silent" })
      // Not a failure: the brain was asked and had nothing to add.
      expect((await jobOf(agent)).status).toBe("done")
    })

    test("PRO-2: a composed message whose brain is down is tried again", async () => {
      const { agent } = agentWith([
        { throws: "the model is down", retryable: true },
        { reply: "Your table is at 8 tonight." },
      ])
      const who = await person(agent)

      await agent.schedule({ personId: who.id, at: clock.now(), compose: "remind them" })

      // The first attempt: every brain is down, so nobody is told
      // anything and the job goes back to the queue (JOB-2).
      await agent.jobs.run(await jobOf(agent))
      const first = await jobOf(agent)
      expect(first.status).toBe("queued")
      expect(first.attempts).toBe(1)
      expect(await agent.store.outbox.count()).toBe(0)
      expect((await agent.store.turns.list())[0]?.outcome).toBe("brains_failed")

      // Driven by hand, because the clock here is frozen: a backoff of
      // any length is a run_at the job loop will never see come due.
      clock.advance(60_000)
      await agent.jobs.run(await jobOf(agent))

      agent.start()
      await until(() => sender.texts().length > 0)

      expect(sender.texts()).toEqual(["Your table is at 8 tonight."])
      const job = await jobOf(agent)
      expect(job.status).toBe("done")
      expect(job.attempts).toBe(2)
    })

    test("PRO-2: a trigger composes from the event and its data", async () => {
      const { agent, brain } = agentWith([{ reply: "Your order is ready for collection." }])
      const who = await person(agent)

      const fired = await agent.trigger({
        personId: who.id,
        event: "order_ready",
        data: { order: "A12", counter: 3 },
      })
      expect(fired.jobId).not.toBe("")

      agent.start()
      await until(() => sender.texts().length > 0)

      expect(sender.texts()).toEqual(["Your order is ready for collection."])
      const notices = JSON.stringify(
        (brain.calls[0]?.messages ?? []).filter((message) => message.role === "notice"),
      )
      expect(notices).toContain("order_ready")
      expect(notices).toContain("A12")
      expect(notices).toContain("3")
    })

    test("PRO-2: a trigger with no event is refused", async () => {
      const { agent } = agentWith()
      const who = await person(agent)

      await expect(agent.trigger({ personId: who.id, event: "  " })).rejects.toThrow(/event/i)
      expect(await agent.store.jobs.count()).toBe(0)
    })
  })

  describe("who hears nothing", () => {
    test("ROLE-4: a blocked person gets no proactive message", async () => {
      const { agent, brain } = agentWith()
      const who = await person(agent)
      await agent.store.people.update({ id: who.id }, { blocked: true })

      await agent.schedule({ personId: who.id, at: clock.now(), text: "Table at 8." })
      await agent.jobs.run(await jobOf(agent))

      expect(sender.texts()).toEqual([])
      expect(await agent.store.outbox.count()).toBe(0)
      expect(brain.calls).toHaveLength(0)
      const ran = await ranProactively(agent)
      expect(ran.props).toMatchObject({ did: "dropped", why: "blocked" })
      // Done, not failed: a blocked person is a decision, not an outage.
      expect((await jobOf(agent)).status).toBe("done")
    })

    test("HAND-5: nothing goes out to a person in a handover", async () => {
      // C11: the bot sends nothing to that person while handed over. A
      // reminder is still the bot.
      const { agent, brain } = agentWith()
      const who = await person(agent)
      await agent.store.handovers.insert({
        person_id: who.id,
        status: "waiting",
        reason: "escalate",
        opened_at: clock.now().toISOString(),
      })

      await agent.schedule({ personId: who.id, at: clock.now(), text: "Table at 8." })
      await agent.jobs.run(await jobOf(agent))

      expect(sender.texts()).toEqual([])
      expect(brain.calls).toHaveLength(0)
      const ran = await ranProactively(agent)
      expect(ran.props).toMatchObject({ did: "dropped", why: "handover" })
    })

    test("LOOP-2: a composed message waits rather than running beside a turn", async () => {
      // One person is one turn at a time, here as well as in the worker.
      const { agent, brain } = agentWith([{ reply: "Your table is at 8 tonight." }])
      const who = await person(agent)
      await agent.store.leases.insert({
        person_id: who.id,
        owner: "another-process",
        expires_at: new Date(clock.now().getTime() + 60_000).toISOString(),
      })

      await agent.schedule({ personId: who.id, at: clock.now(), compose: "remind them" })
      await agent.jobs.run(await jobOf(agent))

      expect(sender.texts()).toEqual([])
      expect(brain.calls).toHaveLength(0)
      expect(await agent.store.turns.count()).toBe(0)
      // Queued again rather than failed, so the reminder is not lost.
      const job = await jobOf(agent)
      expect(job.status).toBe("queued")
      expect(job.attempts).toBe(1)
      expect(job.error).toMatch(/being handled/i)
    })
  })
})
