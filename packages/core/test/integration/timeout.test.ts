// HAND-6 and HAND-7: the two clocks that end a handover when nobody
// else does.
//
// Both exist because a handover is a promise that a person will reply,
// and the tests are written around the two ways that promise is broken
// quietly. Nobody comes and the person is left watching a dead chat, or
// a colleague walks away mid conversation and the person is left with
// nobody at all.
//
// Everything here drives the jobs by hand: advance the clock, find the
// row, run it. That is what a test can do with a frozen clock, and it is
// also the only way to prove a job run early, late or twice decides the
// same thing.
import { test, expect, describe, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { type Agent, type AgentOptions } from "../../src/runtime/index.ts"
import {
  BACK_WITH_BOT,
  HANDOVER_IDLE_JOB,
  HANDOVER_WAITING_JOB,
  PERSON_TOLD,
  PERSON_WAITED,
  WANTS_HUMAN,
} from "../../src/runtime/handover.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool } from "../../src/tools/index.ts"
import { scriptedBrain, type ScriptedStep } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import type { Brain, BrainInput, BrainOutput } from "../../src/providers/brains/types.ts"
import type { HandoverRow, JobRow, PersonRow } from "../../src/store/index.ts"

const SECRET = "test-secret-long-enough-to-look-real"
const PROMPT = "You are the host at a restaurant."
const SUMMARY = "They want a table.\nThe agent could not help.\nThey are waiting."

const MINUTE = 60_000
const agents = trackAgents("timeout.test.ts")

/** Monday, inside the 11:00 to 23:00 hours below, in Asia/Kolkata. */
const MONDAY_NOON = "2026-10-19T07:00:00Z"

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: [["11:00", "23:00"]], tue: [["11:00", "23:00"]] },
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

/** A brain that answers HAND-2's summary request off the script. */
function testBrain(script: ScriptedStep[]): { brain: Brain; calls: BrainInput[] } {
  const scripted = scriptedBrain(script, { exhaustedReply: "Anything else?" })

  const brain: Brain = {
    id: "scripted",
    kind: "api",
    supportsImages: true,
    async complete(input: BrainInput): Promise<BrainOutput> {
      if (input.system.includes("three short lines")) {
        return {
          text: SUMMARY,
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.0001 },
        }
      }
      return scripted.complete(input)
    },
  }

  return { brain, calls: scripted.calls }
}

describeDatabase("handover timeouts", (sql) => {
  const clock = fixedClock(MONDAY_NOON)
  let sender: FakeSender

  beforeEach(async () => {
    await resetDatabase(sql())
    clock.set(MONDAY_NOON)
  })

  function build(
    script: ScriptedStep[],
    over: Record<string, unknown> = {},
  ): { agent: Agent; calls: BrainInput[] } {
    const { brain, calls } = testBrain(script)
    sender = fakeSender()
    const made: AgentOptions = {
      secret: SECRET,
      config: config(over),
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
      tools: [table],
    }
    return { agent: agents.create(made), calls }
  }

  const from = (who: string, text: string, id = `m-${who}-${text.slice(0, 10)}`) => ({
    channel: "whatsapp",
    channelUserId: who,
    channelMessageId: id,
    text,
  })

  const operator = (agent: Agent, id: string, name?: string): Promise<PersonRow> =>
    agent.store.people.insert({
      channel: "whatsapp",
      channel_user_id: id,
      role: "operator",
      ...(name !== undefined ? { display_name: name } : {}),
    })

  /** A waiting handover, opened the way a real one opens. */
  async function waiting(agent: Agent): Promise<HandoverRow> {
    await agent.store.people.insert({
      channel: "whatsapp",
      channel_user_id: "9",
      display_name: "Riya",
    })
    await agent.receiveAndWait(from("9", "get me a manager"))
    const row = await agent.store.handovers.find({})
    return row as HandoverRow
  }

  /** The jobs of one kind, oldest first. */
  const booked = (agent: Agent, kind: string): Promise<JobRow[]> =>
    agent.store.jobs.list({ kind }, { orderBy: "seq" })

  /** Runs the newest job of a kind, which is the one a change booked. */
  async function runLatest(agent: Agent, kind: string): Promise<void> {
    const jobs = await booked(agent, kind)
    const last = jobs.at(-1)
    expect(last).toBeDefined()
    await agent.jobs.run(last as JobRow)
  }

  const to = (who: string): string[] =>
    sender.sent.filter((out) => out.channelUserId === who).map((out) => out.text ?? "")

  const script: ScriptedStep[] = [
    { tool: "escalate", input: { why: "they asked" } },
    { reply: "Someone will be with you." },
  ]

  describe("HAND-6: nobody came", () => {
    test("HAND-6: opening one books the ten minute look", async () => {
      const { agent } = build(script)
      const handover = await waiting(agent)

      const jobs = await booked(agent, HANDOVER_WAITING_JOB)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.payload).toMatchObject({ handoverId: handover.id })
      // Ten minutes after it opened, not after this job was written.
      expect(new Date(jobs[0]?.run_at ?? 0).getTime()).toBe(
        new Date(handover.opened_at).getTime() + 10 * MINUTE,
      )
    })

    test("HAND-6: ten minutes on, the person is told and it becomes unanswered", async () => {
      const { agent } = build(script)
      const handover = await waiting(agent)
      await operator(agent, "op-1", "Asha")
      sender.reset()

      clock.advance(10 * MINUTE)
      await runLatest(agent, HANDOVER_WAITING_JOB)
      await agent.outbox.pump.drain()

      expect((await agent.store.handovers.byId(handover.id))?.status).toBe("unanswered")
      expect(to("9")).toEqual([PERSON_WAITED])
      // HAND-6: it stays open, so an operator can still take it.
      expect((await agent.store.handovers.byId(handover.id))?.ended_at).toBeNull()
    })

    test("HAND-6: before the ten minutes, the job does nothing", async () => {
      const { agent } = build(script)
      const handover = await waiting(agent)
      sender.reset()

      clock.advance(9 * MINUTE)
      await runLatest(agent, HANDOVER_WAITING_JOB)
      await agent.outbox.pump.drain()

      expect((await agent.store.handovers.byId(handover.id))?.status).toBe("waiting")
      expect(to("9")).toEqual([])
    })

    test("HAND-6: the person is told once, however often the job runs", async () => {
      const { agent } = build(script)
      await waiting(agent)
      await operator(agent, "op-1", "Asha")
      sender.reset()

      clock.advance(10 * MINUTE)
      const jobs = await booked(agent, HANDOVER_WAITING_JOB)
      await agent.jobs.run(jobs[0] as JobRow)
      // The same job again, which is what a dying process leaves behind.
      await agent.jobs.run(jobs[0] as JobRow)
      await agent.outbox.pump.drain()

      expect(to("9").filter((text) => text === PERSON_WAITED)).toHaveLength(1)
    })

    test("HAND-6: two jobs at once tell the person once", async () => {
      // Two processes can hold the same job (JOB-3 hands on a job whose
      // owner died), so the status change has to be a claim. Without it
      // both tell the person, both alert the operators, and the digest
      // counts one handover going unanswered twice.
      const { agent, handover } = await (async () => {
        const built = build(script)
        const row = await waiting(built.agent)
        await operator(built.agent, "op-1", "Asha")
        await built.agent.outbox.pump.drain()
        sender.reset()
        return { agent: built.agent, handover: row }
      })()

      clock.advance(10 * MINUTE)
      const both = await Promise.all([
        agent.handovers.waitedTooLong({ handoverId: handover.id }),
        agent.handovers.waitedTooLong({ handoverId: handover.id }),
      ])
      await agent.outbox.pump.drain()

      expect(both.filter((what) => what === "told")).toHaveLength(1)
      expect(to("9").filter((text) => text === PERSON_WAITED)).toHaveLength(1)
      const said = await agent.store.messages.list({ author: "agent" })
      expect(said.filter((one) => one.text === PERSON_WAITED)).toHaveLength(1)
      expect(await agent.store.events.count({ name: "handover_unanswered" })).toBe(1)
    })

    test("HAND-6: taken within the ten minutes, nothing is said", async () => {
      const { agent } = build(script)
      const handover = await waiting(agent)
      const asha = await operator(agent, "op-1", "Asha")
      await agent.handovers.takeOver({ operator: asha })
      sender.reset()

      clock.advance(10 * MINUTE)
      await agent.jobs.run((await booked(agent, HANDOVER_WAITING_JOB))[0] as JobRow)
      await agent.outbox.pump.drain()

      expect((await agent.store.handovers.byId(handover.id))?.status).toBe("active")
      expect(to("9")).toEqual([])
    })

    test("HAND-6: the operators are reminded, and the reminder says so", async () => {
      const { agent } = build(script)
      await waiting(agent)
      await operator(agent, "op-1", "Asha")
      await operator(agent, "op-2", "Ravi")
      sender.reset()

      clock.advance(10 * MINUTE)
      await runLatest(agent, HANDOVER_WAITING_JOB)
      await agent.outbox.pump.drain()

      // A second alert, not a duplicate of the first dropped by the outbox.
      expect(to("op-1")).toHaveLength(1)
      expect(to("op-2")).toHaveLength(1)
      expect(to("op-1")[0]).toContain("Still waiting after 10 minutes")
      expect(to("op-1")[0]).toContain("Riya (whatsapp 9)")
    })

    test("HAND-6: the reminder comes round again an hour later", async () => {
      const { agent } = build(script)
      await waiting(agent)
      await operator(agent, "op-1", "Asha")

      clock.advance(10 * MINUTE)
      await runLatest(agent, HANDOVER_WAITING_JOB)
      sender.reset()

      // Half an hour on is too soon, and the job says so rather than
      // sending a second reminder.
      clock.advance(30 * MINUTE)
      await runLatest(agent, HANDOVER_WAITING_JOB)
      await agent.outbox.pump.drain()
      expect(to("op-1")).toEqual([])

      const before = (await booked(agent, HANDOVER_WAITING_JOB)).length
      clock.advance(31 * MINUTE)
      await runLatest(agent, HANDOVER_WAITING_JOB)
      await agent.outbox.pump.drain()
      expect(to("op-1")).toHaveLength(1)
      expect(to("op-1")[0]).toContain("Still waiting after 71 minutes")

      // And the one after that is already booked, an hour on. Without
      // this the reminder happens once and the alarm is gone.
      const after = await booked(agent, HANDOVER_WAITING_JOB)
      expect(after.length).toBeGreaterThan(before)
      expect(new Date(after.at(-1)?.run_at ?? 0).getTime()).toBe(
        clock.now().getTime() + 60 * MINUTE,
      )
    })

    test("HAND-6: outside opening hours nobody is reminded", async () => {
      const { agent } = build(script)
      await waiting(agent)
      await operator(agent, "op-1", "Asha")

      clock.advance(10 * MINUTE)
      await runLatest(agent, HANDOVER_WAITING_JOB)
      sender.reset()

      // 02:30 the next morning, which the hours say is closed.
      clock.set("2026-10-19T21:00:00Z")
      await runLatest(agent, HANDOVER_WAITING_JOB)
      await agent.outbox.pump.drain()
      expect(to("op-1")).toEqual([])

      // And it comes back when the agent is open again.
      clock.set("2026-10-20T07:00:00Z")
      await runLatest(agent, HANDOVER_WAITING_JOB)
      await agent.outbox.pump.drain()
      expect(to("op-1")).toHaveLength(1)
    })

    test("HAND-6: it is in the trace, with what the job decided", async () => {
      const { agent } = build(script)
      await waiting(agent)

      clock.advance(10 * MINUTE)
      await runLatest(agent, HANDOVER_WAITING_JOB)

      const unanswered = await agent.store.events.list({ name: "handover_unanswered" })
      expect(unanswered).toHaveLength(1)
      expect(unanswered[0]?.props).toMatchObject({ waitedMinutes: 10, reason: "escalate" })
      const ran = await agent.store.events.list({ name: "job_ran" })
      expect(ran.some((row) => (row.props as { did?: string }).did === "told")).toBe(true)
    })

    test("HAND-6: an unanswered handover can still be taken", async () => {
      const { agent } = build(script)
      const handover = await waiting(agent)
      const asha = await operator(agent, "op-1", "Asha")

      clock.advance(10 * MINUTE)
      await runLatest(agent, HANDOVER_WAITING_JOB)
      const taken = await agent.handovers.takeOver({ operator: asha })

      expect(taken.kind).toBe("taken")
      expect((await agent.store.handovers.byId(handover.id))?.status).toBe("active")
    })
  })

  describe("HAND-7: the colleague walked away", () => {
    /** An active handover, held by Asha. */
    async function active(
      extra: ScriptedStep[] = [],
    ): Promise<{ agent: Agent; calls: BrainInput[]; asha: PersonRow; handover: HandoverRow }> {
      const { agent, calls } = build([...script, ...extra])
      const asha = await operator(agent, "op-1", "Asha")
      const handover = await waiting(agent)
      await agent.handovers.takeOver({ operator: asha })
      await agent.outbox.pump.drain()
      sender.reset()
      return { agent, calls, asha, handover }
    }

    test("HAND-7: taking one books the half hour", async () => {
      const { agent, handover } = await active()

      const jobs = await booked(agent, HANDOVER_IDLE_JOB)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.payload).toMatchObject({ handoverId: handover.id })
      expect(new Date(jobs[0]?.run_at ?? 0).getTime()).toBe(clock.now().getTime() + 30 * MINUTE)
    })

    test("HAND-7: half an hour of silence gives the person back to the agent", async () => {
      const { agent, handover } = await active()

      clock.advance(30 * MINUTE)
      await runLatest(agent, HANDOVER_IDLE_JOB)

      const row = await agent.store.handovers.byId(handover.id)
      expect(row?.status).toBe("closed")
      expect(row?.ended_reason).toBe("idle")
      // HAND-7: the brain is told, in the history.
      const notices = await agent.store.messages.list({ author: "notice" })
      expect(notices.map((one) => one.text)).toContain(BACK_WITH_BOT)
    })

    test("HAND-7: the person is answered again, and is never told why", async () => {
      const { agent } = await active([{ reply: "How can I help?" }])

      clock.advance(30 * MINUTE)
      await runLatest(agent, HANDOVER_IDLE_JOB)
      await agent.outbox.pump.drain()
      // Nothing was said to them about it. From where they sit, the next
      // thing they ask is simply answered.
      expect(to("9")).toEqual([])

      const next = await agent.receiveAndWait(from("9", "are you there?", "m-back"))
      expect(next.turn?.outcome).toBe("replied")
      expect(to("9")).toEqual(["How can I help?"])
    })

    test("HAND-7: the operator is told, because they think they still have it", async () => {
      const { agent } = await active()

      clock.advance(30 * MINUTE)
      await runLatest(agent, HANDOVER_IDLE_JOB)
      await agent.outbox.pump.drain()

      expect(to("op-1")).toHaveLength(1)
      expect(to("op-1")[0]).toContain("Riya (whatsapp 9)")
      expect(to("op-1")[0]).toContain("goes to the agent")
    })

    test("HAND-7: a word from the operator pushes the half hour out", async () => {
      const { agent, handover } = await active()

      // 25 minutes in, the colleague says something.
      clock.advance(25 * MINUTE)
      const before = (await booked(agent, HANDOVER_IDLE_JOB)).length
      await agent.receiveAndWait(from("op-1", "sorry for the wait, checking now"))

      // Their words book the next look. Without that, the only job left
      // is the one from when they took it, and once it has run nothing
      // ever looks at this handover again.
      const booksNow = await booked(agent, HANDOVER_IDLE_JOB)
      expect(booksNow.length).toBeGreaterThan(before)
      expect(new Date(booksNow.at(-1)?.run_at ?? 0).getTime()).toBe(
        clock.now().getTime() + 30 * MINUTE,
      )

      // The job booked when they took it comes due and finds them talking.
      clock.advance(5 * MINUTE)
      await agent.jobs.run((await booked(agent, HANDOVER_IDLE_JOB))[0] as JobRow)
      expect((await agent.store.handovers.byId(handover.id))?.status).toBe("active")

      // The job their message booked is the one that ends it.
      clock.advance(26 * MINUTE)
      await runLatest(agent, HANDOVER_IDLE_JOB)
      expect((await agent.store.handovers.byId(handover.id))?.status).toBe("closed")
    })

    test("HAND-7: a word from the person pushes it out too", async () => {
      const { agent, handover } = await active()

      clock.advance(25 * MINUTE)
      const before = (await booked(agent, HANDOVER_IDLE_JOB)).length
      await agent.receiveAndWait(from("9", "any news?", "m-news"))

      // The person speaking books the next look too, for the same
      // reason: a handover with no job left is a handover nothing ends.
      const booksNow = await booked(agent, HANDOVER_IDLE_JOB)
      expect(booksNow.length).toBeGreaterThan(before)
      expect(new Date(booksNow.at(-1)?.run_at ?? 0).getTime()).toBe(
        clock.now().getTime() + 30 * MINUTE,
      )

      clock.advance(10 * MINUTE)
      await runLatest(agent, HANDOVER_IDLE_JOB)
      expect((await agent.store.handovers.byId(handover.id))?.status).toBe("active")
    })

    test("HAND-7: a notice in the middle is not somebody talking", async () => {
      // The conversation carries notices as well as words: the core
      // telling the person something, or telling the brain. If one of
      // those counted, a handover nobody touched would look busy and
      // the person would be left with a colleague who has gone home.
      const { agent, handover } = await active()

      clock.advance(20 * MINUTE)
      await agent.store.messages.insert({
        person_id: handover.person_id,
        direction: "inbound",
        author: "notice",
        text: "Something the core said, not either of them.",
        channel: "whatsapp",
        created_at: clock.now().toISOString(),
      })

      clock.advance(11 * MINUTE)
      await runLatest(agent, HANDOVER_IDLE_JOB)

      expect((await agent.store.handovers.byId(handover.id))?.status).toBe("closed")
    })

    test("HAND-2 and HAND-6: what the core told the person is in the history", async () => {
      // LOOP-7 hands the brain the conversation, and the person can see
      // both of these lines in their chat. A brain that cannot see them
      // will say one of them a second time.
      const { agent } = build(script)
      await waiting(agent)

      clock.advance(10 * MINUTE)
      await runLatest(agent, HANDOVER_WAITING_JOB)

      const theirs = await agent.store.messages.list({ author: "agent" }, { orderBy: "seq" })
      // In the order the person saw them: `escalate` runs mid turn, so the
      // core's line is queued and stored before the brain's own reply.
      expect(theirs.map((one) => one.text)).toEqual([
        PERSON_TOLD,
        "Someone will be with you.",
        PERSON_WAITED,
      ])
    })

    test("HAND-7: resume while the job is due closes it once", async () => {
      const { agent, asha, handover } = await active()

      clock.advance(30 * MINUTE)
      const done = await agent.handovers.resume({ operator: asha })
      await runLatest(agent, HANDOVER_IDLE_JOB)

      expect(done.kind).toBe("resumed")
      const row = await agent.store.handovers.byId(handover.id)
      expect(row?.ended_reason).toBe("resume")
      // One close, one note, one event.
      const notices = await agent.store.messages.list({ author: "notice" })
      expect(notices.filter((one) => one.text === BACK_WITH_BOT)).toHaveLength(1)
      expect(await agent.store.events.count({ name: "handover_ended" })).toBe(1)
    })

    test("HAND-7: resume and the idle job at the same moment close it once", async () => {
      // Both read the row and then close it, so the claim is the only
      // thing standing between one close and two: two notes in the
      // history, two events, and a digest that counts the same handover
      // ending twice.
      const { agent, asha, handover } = await active()

      clock.advance(30 * MINUTE)
      const [resumed, ended] = await Promise.all([
        agent.handovers.resume({ operator: asha }),
        agent.handovers.endIfIdle({ handoverId: handover.id }),
      ])

      // Exactly one of them did it, and either one is a fine outcome.
      const winners = [resumed.kind === "resumed", ended === "ended"].filter(Boolean)
      expect(winners).toHaveLength(1)
      const notices = await agent.store.messages.list({ author: "notice" })
      expect(notices.filter((one) => one.text === BACK_WITH_BOT)).toHaveLength(1)
      expect(await agent.store.events.count({ name: "handover_ended" })).toBe(1)
    })

    test("HAND-7: a waiting handover is not idle, whatever the idle job thinks", async () => {
      // The waiting clock is HAND-6's and ends in a reminder. Only an
      // active one can go quiet, so an idle job that arrives for a
      // handover nobody took must not close it.
      const { agent } = build(script)
      const handover = await waiting(agent)

      clock.advance(60 * MINUTE)
      const what = await agent.handovers.endIfIdle({ handoverId: handover.id })

      expect(what).toBe("nothing")
      expect((await agent.store.handovers.byId(handover.id))?.status).toBe("waiting")
    })

    test("HAND-7: an operator typing after it ended is talking to the agent", async () => {
      // HAND-4 read the other way round: once it is closed there is no
      // focus, so their words go to the brain. This is why they are told.
      const { agent } = await active([{ reply: "Nothing is waiting." }])

      clock.advance(30 * MINUTE)
      await runLatest(agent, HANDOVER_IDLE_JOB)
      await agent.outbox.pump.drain()
      sender.reset()

      const result = await agent.receiveAndWait(from("op-1", "still here?"))

      expect(result.turn?.outcome).toBe("replied")
      expect(to("9")).toEqual([])
      expect(to("op-1")).toEqual(["Nothing is waiting."])
    })
  })

  describe("HAND-6 and HAND-7: the config decides", () => {
    test("HAND-6: a shop that waits two minutes waits two minutes", async () => {
      const { agent } = build(script, {
        handover: { noOperatorMinutes: 2, idleMinutes: 5, alertRepeatMinutes: 15 },
      })
      const handover = await waiting(agent)
      sender.reset()

      clock.advance(2 * MINUTE)
      await runLatest(agent, HANDOVER_WAITING_JOB)
      await agent.outbox.pump.drain()

      expect((await agent.store.handovers.byId(handover.id))?.status).toBe("unanswered")
      expect(to("9")).toEqual([PERSON_WAITED])
    })

    test("HAND-7: so does a shop that gives a colleague five minutes", async () => {
      const { agent } = build(script, {
        handover: { noOperatorMinutes: 2, idleMinutes: 5, alertRepeatMinutes: 15 },
      })
      const asha = await operator(agent, "op-1", "Asha")
      const handover = await waiting(agent)
      await agent.handovers.takeOver({ operator: asha })

      clock.advance(5 * MINUTE)
      await runLatest(agent, HANDOVER_IDLE_JOB)

      expect((await agent.store.handovers.byId(handover.id))?.status).toBe("closed")
    })
  })
})
