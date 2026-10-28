// PRO-3, PRO-4 and LOOP-5 step 2: the rules about when a message may go
// out at all.
//
// These are the rules that are not about the agent being right. They are
// about the person's wishes and the channel's terms: somebody said stop,
// it is half past ten at night, or WhatsApp will not take free text from
// us any more because they last wrote on Tuesday. Each one is a way for a
// correct message to be the wrong thing to send.
//
// Two of them are also C16's bar, so they are tested the way C16 reads
// them: after STOP nothing goes out until the person opts back in, and
// nothing non urgent goes out in quiet hours.
import { test, expect, describe, beforeAll, beforeEach } from "bun:test"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { migrate } from "../../src/migrate/index.ts"
import {
  OPTED_IN_REPLY,
  OPTED_OUT_REPLY,
  type Agent,
  type AgentOptions,
} from "../../src/runtime/index.ts"
import { PROACTIVE_JOB } from "../../src/runtime/proactive.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { scriptedBrain, type ScriptedBrain } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import {
  fakeSender,
  type FakeSender,
  type FakeSenderOptions,
} from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import { WANTS_HUMAN } from "../../src/runtime/handover.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import type { JobRow, OutboxRow, PersonRow } from "../../src/store/index.ts"

const PROMPT = "You are the host at a restaurant."

/** 11:30 in Asia/Kolkata, which is the middle of the agent's day. */
const DAYTIME = "2026-10-19T06:00:00Z"
/** 22:30 the same evening, which is inside the default quiet hours. */
const NIGHT = "2026-10-19T17:00:00Z"
/** 09:00 the next morning, where a message sent at 22:30 waits until. */
const MORNING = "2026-10-20T03:30:00.000Z"

const agents = trackAgents("sendrules.test.ts")

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
    sendAttempts: 3,
    sendBackoffMs: 1,
    jobAttempts: 3,
    jobBackoffMs: 1,
    ...over,
  })
}

describeDatabase("the send rules", (sql) => {
  const clock = fixedClock(DAYTIME)
  let sender: FakeSender

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
    clock.set(DAYTIME)
  })

  interface Built {
    agent: Agent
    brain: ScriptedBrain
  }

  function agentWith(
    options: {
      reply?: string
      channel?: FakeSenderOptions["capabilities"]
      start?: boolean
      /** PRO-5: the event to template map. */
      triggers?: Record<string, string>
    } = {},
  ): Built {
    const brain = scriptedBrain([{ reply: options.reply ?? "We open at 11." }], {
      exhaustedReply: "Anything else?",
    })
    sender = fakeSender(options.channel !== undefined ? { capabilities: options.channel } : {})
    const build: AgentOptions = {
      config: config(options.triggers !== undefined ? { triggers: options.triggers } : {}),
      deps: {
        brains: [brain],
        decisionModel: scriptedDecisionModel([
          { [WANTS_HUMAN]: yesno(0), [GATE_QUESTION]: yesno(1) },
        ]),
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: PROMPT,
      tools: [],
    }
    const agent = options.start === true ? agents.create(build) : agents.build(build)
    return { agent, brain }
  }

  const person = (agent: Agent, id = "9"): Promise<PersonRow> =>
    agent.store.people.insert({
      channel: "whatsapp",
      channel_user_id: id,
      display_name: "Asha",
    })

  const from = (text: string, id = `m-${text.slice(0, 10)}`) => ({
    channel: "whatsapp",
    channelUserId: "9",
    channelMessageId: id,
    text,
  })

  /** One proactive row, queued straight into the outbox. */
  async function queued(
    agent: Agent,
    who: PersonRow,
    over: Record<string, unknown> = {},
  ): Promise<OutboxRow> {
    return agent.outbox.queue({
      personId: who.id,
      kind: "proactive",
      channel: who.channel,
      channelUserId: who.channel_user_id,
      text: "Your table is at 8 tonight.",
      idempotencyKey: `test-${Math.random().toString(36).slice(2)}`,
      ...over,
    })
  }

  const jobOf = async (agent: Agent): Promise<JobRow> => {
    const [job] = await agent.store.jobs.list({ kind: PROACTIVE_JOB }, { orderBy: "run_at" })
    if (job === undefined) throw new Error("no proactive job was written")
    return job
  }

  async function until(what: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms
    while (!what() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  describe("LOOP-5 step 2: STOP and START", () => {
    test("LOOP-5: STOP opts the person out and confirms it", async () => {
      const { agent, brain } = agentWith({ start: true })

      const result = await agent.receiveAndWait(from("STOP"))

      expect(result.turn?.outcome).toBe("opted_out")
      expect((await agent.store.people.list())[0]?.opted_out).toBe(true)
      expect(sender.texts()).toEqual([OPTED_OUT_REPLY])
      // The whole turn is one column and one fixed line. Nothing is
      // asked of a model to work out what STOP means.
      expect(brain.calls).toHaveLength(0)
      expect(await agent.store.decisions.count()).toBe(0)
    })

    test("LOOP-5: START opts them back in and confirms it", async () => {
      const { agent } = agentWith({ start: true })
      await agent.receiveAndWait(from("STOP"))
      sender.reset()

      const result = await agent.receiveAndWait(from("start"))

      expect(result.turn?.outcome).toBe("opted_in")
      expect((await agent.store.people.list())[0]?.opted_out).toBe(false)
      expect(sender.texts()).toEqual([OPTED_IN_REPLY])
    })

    test("LOOP-5: the word is read in any case and with spaces around it", async () => {
      const { agent } = agentWith({ start: true })

      await agent.receiveAndWait(from("  Stop  "))

      expect((await agent.store.people.list())[0]?.opted_out).toBe(true)
    })

    test("LOOP-5: stop by on friday is a message for the brain, not an opt out", async () => {
      const { agent, brain } = agentWith({ start: true, reply: "See you Friday." })

      await agent.receiveAndWait(from("can i stop by on friday"))

      expect((await agent.store.people.list())[0]?.opted_out).toBe(false)
      expect(brain.calls).toHaveLength(1)
      expect(sender.texts()).toEqual(["See you Friday."])
    })

    test("LOOP-5: STOP decides the turn even while a handover is open", async () => {
      // LOOP-5's order: the opt out is step 2 and the handover is step 5.
      // The one message a person must always get through is the one that
      // makes us stop.
      const { agent } = agentWith({ start: true })
      const who = await person(agent)
      await agent.store.handovers.insert({
        person_id: who.id,
        status: "waiting",
        reason: "escalate",
        opened_at: clock.now().toISOString(),
      })

      const result = await agent.receiveAndWait(from("STOP"))

      expect(result.turn?.outcome).toBe("opted_out")
      expect((await agent.store.people.list())[0]?.opted_out).toBe(true)
      expect(sender.texts()).toEqual([OPTED_OUT_REPLY])
      // Still open: opting out of messages is not resuming a handover.
      expect((await agent.store.handovers.list())[0]?.status).toBe("waiting")
    })
  })

  describe("PRO-3 rule 1: the opt out", () => {
    test("PRO-3: a message queued before they opted out is still dropped", async () => {
      // The check that matters, in the place PRO-3 puts it: just before
      // the send, so a message already in the queue cannot slip past.
      const { agent } = agentWith()
      const who = await person(agent)
      const row = await queued(agent, who)
      await agent.store.people.update({ id: who.id }, { opted_out: true })

      const done = await agent.outbox.attempt(row)

      expect(done.status).toBe("failed")
      expect(done.error).toMatch(/opted out/i)
      expect(sender.sent).toHaveLength(0)
      const failed = await agent.store.events.find({ name: "send_failed" })
      expect(failed?.props).toMatchObject({ error: "the person has opted out" })
    })

    test("PRO-3: a scheduled message for somebody who opted out is never written", async () => {
      const { agent, brain } = agentWith()
      const who = await person(agent)
      await agent.store.people.update({ id: who.id }, { opted_out: true })

      await agent.schedule({ personId: who.id, at: clock.now(), compose: "remind them" })
      await agent.jobs.run(await jobOf(agent))

      // Dropped before the turn, so it costs nothing at all.
      expect(brain.calls).toHaveLength(0)
      expect(await agent.store.outbox.count()).toBe(0)
      expect(sender.sent).toHaveLength(0)
    })

    test("PRO-4: a reply still goes out to somebody who opted out", async () => {
      // PRO-4: they asked us to stop starting conversations, not to stop
      // answering them.
      const { agent } = agentWith({ start: true, reply: "We open at 11." })
      const who = await person(agent)
      await agent.store.people.update({ id: who.id }, { opted_out: true })

      await agent.receiveAndWait(from("what time do you open?"))

      expect(sender.texts()).toEqual(["We open at 11."])
    })

    test("C16: after STOP nothing goes out, and after START it does", async () => {
      const { agent } = agentWith({ start: true })
      const who = await person(agent)

      await agent.receiveAndWait(from("STOP", "m-stop"))
      sender.reset()
      await agent.schedule({ personId: who.id, at: clock.now(), text: "Table at 8." })
      await agent.settled()

      expect(sender.texts()).toEqual([])

      await agent.receiveAndWait(from("START", "m-start"))
      sender.reset()
      await agent.schedule({ personId: who.id, at: clock.now(), text: "Table at 8." })
      await until(() => sender.texts().length > 0)
      await agent.settled()

      expect(sender.texts()).toEqual(["Table at 8."])
    })
  })

  describe("PRO-3 rule 2: quiet hours", () => {
    test("PRO-3: a non urgent message in quiet hours waits until they end", async () => {
      const { agent } = agentWith()
      const who = await person(agent)
      clock.set(NIGHT)
      const row = await queued(agent, who)

      const held = await agent.outbox.attempt(row)

      expect(held.status).toBe("queued")
      // Compared as an instant: Postgres writes the same moment as +00:00.
      expect(new Date(held.not_before).toISOString()).toBe(MORNING)
      expect(sender.sent).toHaveLength(0)
      // Not an attempt: nothing was sent and nothing failed, so the
      // retry budget is untouched.
      expect(held.attempts).toBe(0)
    })

    test("PRO-3: an urgent message goes out in quiet hours", async () => {
      const { agent } = agentWith()
      const who = await person(agent)
      clock.set(NIGHT)
      const row = await queued(agent, who, { urgent: true })

      const done = await agent.outbox.attempt(row)

      expect(done.status).toBe("sent")
      expect(sender.texts()).toEqual(["Your table is at 8 tonight."])
    })

    test("PRO-4: a reply goes out in quiet hours", async () => {
      const { agent } = agentWith({ start: true, reply: "We open at 11 tomorrow." })
      clock.set(NIGHT)

      await agent.receiveAndWait(from("are you open?"))

      expect(sender.texts()).toEqual(["We open at 11 tomorrow."])
    })

    test("PRO-3: the opt out is read before quiet hours", async () => {
      // The order in PRO-3 is the rule. Opted out plus quiet hours has to
      // be dropped, not held until morning and sent then.
      const { agent } = agentWith()
      const who = await person(agent)
      await agent.store.people.update({ id: who.id }, { opted_out: true })
      clock.set(NIGHT)
      const row = await queued(agent, who)

      const done = await agent.outbox.attempt(row)

      expect(done.status).toBe("failed")
      expect(done.error).toMatch(/opted out/i)
    })

    test("PRO-3: a composed message in quiet hours is written in the morning", async () => {
      // Deferring the send would send last night's words: "your table is
      // at 8 tonight", arriving at nine the next day. So the job books
      // itself again and the brain writes it then.
      const { agent, brain } = agentWith({ reply: "Your table is at 8 tonight." })
      const who = await person(agent)
      clock.set(NIGHT)
      await agent.schedule({ personId: who.id, at: clock.now(), compose: "remind them" })

      await agent.jobs.run(await jobOf(agent))

      expect(brain.calls).toHaveLength(0)
      expect(await agent.store.outbox.count()).toBe(0)
      const jobs = await agent.store.jobs.list({ kind: PROACTIVE_JOB }, { orderBy: "run_at" })
      expect(jobs).toHaveLength(2)
      expect(new Date(jobs[1]?.run_at ?? 0).toISOString()).toBe(MORNING)
      expect(jobs[1]?.status).toBe("queued")

      // Morning, and the second job writes it.
      clock.set(new Date(MORNING))
      await agent.jobs.run(jobs[1] as JobRow)
      agent.start()
      await until(() => sender.texts().length > 0)
      await agent.settled()

      expect(brain.calls).toHaveLength(1)
      expect(sender.texts()).toEqual(["Your table is at 8 tonight."])
    })

    test("PRO-3: an urgent composed message is written in the night", async () => {
      const { agent, brain } = agentWith({ reply: "Your table is ready now." })
      const who = await person(agent)
      clock.set(NIGHT)
      await agent.schedule({
        personId: who.id,
        at: clock.now(),
        compose: "tell them the table is ready",
        urgent: true,
      })

      await agent.jobs.run(await jobOf(agent))
      agent.start()
      await until(() => sender.texts().length > 0)
      await agent.settled()

      expect(brain.calls).toHaveLength(1)
      expect(sender.texts()).toEqual(["Your table is ready now."])
      expect(await agent.store.jobs.count({ kind: PROACTIVE_JOB })).toBe(1)
    })
  })

  describe("PRO-3 rule 3: the channel's window", () => {
    const whatsapp = { windowHours: 24, templates: true }

    test("PRO-3: inside the window, free text goes out", async () => {
      const { agent } = agentWith({ channel: whatsapp, start: true })
      await agent.receiveAndWait(from("what time do you open?"))
      sender.reset()
      const who = (await agent.store.people.list())[0] as PersonRow

      const row = await queued(agent, who)
      const done = await agent.outbox.attempt(row)

      expect(done.status).toBe("sent")
      expect(sender.texts()).toEqual(["Your table is at 8 tonight."])
    })

    test("PRO-3: outside the window, free text fails and is flagged", async () => {
      const { agent } = agentWith({ channel: whatsapp })
      const who = await person(agent)
      // They last wrote 25 hours ago, which is one hour too long ago.
      await agent.store.messages.insert({
        person_id: who.id,
        direction: "inbound",
        author: "person",
        text: "any space on monday?",
        channel: who.channel,
        created_at: new Date(clock.now().getTime() - 25 * 3_600_000).toISOString(),
      })

      const row = await queued(agent, who)
      const done = await agent.outbox.attempt(row)

      expect(done.status).toBe("failed")
      expect(done.error).toMatch(/only takes a template/i)
      expect(sender.sent).toHaveLength(0)

      // LEARN-1: and flagged, because nobody is waiting for a reminder
      // and nothing else would ever say it did not arrive.
      const [flag] = await agent.store.flags.list()
      expect(flag?.kind).toBe("send_blocked")
      expect(flag?.detail).toMatchObject({ channel: "whatsapp", windowHours: 24 })
      expect(await agent.store.events.count({ name: "flag_raised" })).toBe(1)
    })

    test("PRO-3: outside the window, a template goes out", async () => {
      const { agent } = agentWith({ channel: whatsapp })
      const who = await person(agent)

      const row = await queued(agent, who, {
        text: undefined,
        template: { name: "table_reminder", vars: { time: "20:00" } },
      })
      const done = await agent.outbox.attempt(row)

      expect(done.status).toBe("sent")
      expect(sender.sent[0]?.template).toMatchObject({ name: "table_reminder" })
      expect(await agent.store.flags.count()).toBe(0)
    })

    test("PRO-5 and PRO-3: a triggered event reaches somebody outside the window", async () => {
      // Known K20, closed, end to end. Before PRO-5 this exact case was
      // the gap: Intent 16's own example, "order ready" to a customer who
      // last wrote two days ago. The brain wrote a sentence, the window
      // rule refused it because free text needs the window, and the
      // person never heard. One brain call spent on nothing.
      //
      // Now config names the template for the event, so the message that
      // reaches the outbox is already a template and the window rule lets
      // it through. Nothing is written by the brain at all.
      const { agent, brain } = agentWith({
        channel: whatsapp,
        triggers: { order_ready: "order_ready_v1" },
      })
      const who = await person(agent)

      await agent.trigger({ personId: who.id, event: "order_ready", data: { order: "41" } })
      const job = (await agent.store.jobs.list({}, { orderBy: "seq" }))[0]
      await agent.jobs.run(job as never)

      const row = await agent.store.outbox.find({ person_id: who.id })
      const done = await agent.outbox.attempt(row as never)

      expect(done.status).toBe("sent")
      expect(sender.sent[0]?.template).toMatchObject({ name: "order_ready_v1" })
      // No brain call, and nothing flagged, which is the whole saving.
      expect(brain.calls).toHaveLength(0)
      expect(await agent.store.flags.count()).toBe(0)
    })

    test("PRO-3: somebody who has never written is outside the window", async () => {
      const { agent } = agentWith({ channel: whatsapp })
      const who = await person(agent)

      const done = await agent.outbox.attempt(await queued(agent, who))

      expect(done.status).toBe("failed")
      expect(sender.sent).toHaveLength(0)
    })

    test("PRO-3: a channel that declares no window takes free text whenever", async () => {
      // The default fake sender declares none, like Telegram.
      const { agent } = agentWith()
      const who = await person(agent)

      const done = await agent.outbox.attempt(await queued(agent, who))

      expect(done.status).toBe("sent")
      expect(await agent.store.flags.count()).toBe(0)
    })
  })
})
