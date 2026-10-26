// BUILTIN-2 and BUILTIN-3 on real turns, and C14 in full:
//
// "A booking spread over five turns, with an unrelated question in the
// middle, completes with every field correct. An idle task expires."
//
// The interruption is the point. Without a task, the only memory of what
// has been collected is thirty messages of history, and a brain re-reading
// them after a detour about parking will sometimes decide it already has
// the party size. The task is what makes that a question with an answer.
import { test, expect, describe, beforeAll, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { migrate } from "../../src/migrate/index.ts"
import { type Agent, type AgentOptions } from "../../src/runtime/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool, type Tool } from "../../src/tools/index.ts"
import { TASK_EXPIRE_JOB } from "../../src/tools/tasks.ts"
import {
  scriptedBrain,
  type ScriptedBrain,
  type ScriptedStep,
} from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import { fakeToolContext } from "../../src/testing/tool-context.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { WANTS_HUMAN } from "../../src/runtime/handover.ts"
import { buttonPayload } from "../../src/runtime/confirm.ts"

const SECRET = "test-secret-long-enough-to-look-real"
const PROMPT = "You are the host at a restaurant."

const agents = trackAgents("tasks.test.ts")

function createAgent(options: AgentOptions): Agent {
  return agents.create({ secret: SECRET, ...options })
}

const TASK_TYPES = {
  booking: {
    fields: { date: "required", time: "required", size: "required", notes: "optional" },
    idleHours: 24,
  },
}

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
    taskTypes: TASK_TYPES,
    ...over,
  } as never)
}

let booked: Record<string, unknown>[] = []

const bookTable = defineTool({
  name: "book_table",
  description: "Books a table, which cannot be undone.",
  input: z.object({ date: z.string(), time: z.string(), size: z.number().int().min(1) }),
  risk: "irreversible",
  roles: ["end_user"],
  conditions: {
    callWhen: ["Every detail of the booking is known and the person has agreed"],
    dontCallWhen: ["Anything is still missing"],
  },
  confirmSummary: (args) => `Table for ${args.size} on ${args.date} at ${args.time}`,
  examples: { should: ["book it"], shouldNot: ["any space friday?"] },
  handler: async (args) => {
    booked.push(args)
    return { booked: true }
  },
})

const parking = defineTool({
  name: "parking",
  description: "Says what parking there is.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask about parking"], dontCallWhen: ["they do not"] },
  examples: { should: ["is there parking?"], shouldNot: ["book a table"] },
  handler: async () => ({ spaces: 14 }),
})

describeDatabase("tasks", (sql) => {
  let sender: FakeSender
  const clock = fixedClock("2026-10-19T06:00:00Z")

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
    booked = []
    clock.set("2026-10-19T06:00:00Z")
  })

  function agentWith(
    script: ScriptedStep[],
    tools: Tool[] = [bookTable, parking],
    over: Record<string, unknown> = {},
  ): { agent: Agent; brain: ScriptedBrain } {
    const brain = scriptedBrain(script)
    sender = fakeSender()
    const agent = createAgent({
      config: config(over),
      deps: {
        brains: [brain],
        decisionModel: scriptedDecisionModel([{ [GATE_QUESTION]: yesno(1) }]),
        db: localSupabase(),
        sender,
        clock,
      },
      prompt: PROMPT,
      tools,
    })
    return { agent, brain }
  }

  /**
   * TOOL-4's context, for calling one task tool directly.
   *
   * The task tools are the core's, so a test can reach them without a
   * brain in the way. `fakeToolContext` rather than an object literal,
   * because a literal breaks every time the core adds a field to `ctx`.
   */
  const ctxFor = (agent: Agent, personId: string) =>
    fakeToolContext({ config: config(), db: agent.store, clock, person: { id: personId } })

  const says = (text: string, id: string) => ({
    channel: "whatsapp",
    channelUserId: "42",
    channelMessageId: id,
    text,
  })

  describe("BUILTIN-1: what the brain is offered", () => {
    test("BUILTIN-1: the task tools are offered on every step, without routing", async () => {
      const { agent, brain } = agentWith([{ reply: "Hello." }])
      await agent.receiveAndWait(says("hello", "m1"))

      const offered = brain.calls[0]?.tools.map((tool) => tool.name) ?? []
      expect(offered).toContain("start_task")
      expect(offered).toContain("update_task")
      expect(offered).toContain("switch_task")
      expect(offered).toContain("close_task")
    })

    test("BUILTIN-2: an agent that declares no task types is offered none of them", async () => {
      // Four tool schemas on every call is a real cost, and an agent with
      // nothing multi turn to track cannot use them.
      const { agent, brain } = agentWith([{ reply: "Hello." }], [parking], { taskTypes: {} })
      await agent.receiveAndWait(says("hello", "m1"))

      // BUILTIN-1: `remember` and `forget_fact` are there for every
      // agent. The four task tools are not, because nothing is declared.
      const offered = brain.calls[0]?.tools.map((tool) => tool.name) ?? []
      // The core's own come first, as ROUTE-2 exposes them: the two fact
      // tools and `escalate`, which every end user has (section 10).
      expect(offered).toEqual(["remember", "forget_fact", "escalate", "parking"])
    })

    test("BUILTIN-1: built in tools do not count toward routingMinTools", async () => {
      // Two agent tools and four built ins is still a two tool agent, so
      // routing is not asked and the brain sees everything.
      const decisions = scriptedDecisionModel([{ [GATE_QUESTION]: yesno(1) }])
      const brain = scriptedBrain([{ reply: "Hello." }])
      sender = fakeSender()
      const agent = createAgent({
        config: config(),
        deps: { brains: [brain], decisionModel: decisions, db: localSupabase(), sender, clock },
        prompt: PROMPT,
        tools: [bookTable, parking],
      })

      const result = await agent.receiveAndWait(says("hello", "m1"))

      expect(result.turn?.routed[0]?.reason).toBe("not_routed")
      // One request, which is LOOP-8 step 1 asking `wants_human` (HAND-1),
      // and routing is not one of its questions.
      expect(decisions.calls).toHaveLength(1)
      expect(Object.keys(decisions.calls[0]?.questions ?? {})).toEqual([WANTS_HUMAN])
      // Two agent tools, four task tools, remember, forget_fact, escalate.
      expect(brain.calls[0]?.tools).toHaveLength(9)
    })
  })

  describe("BUILTIN-2: starting and filling a task", () => {
    test("BUILTIN-2: start_task opens one, active, with missing worked out", async () => {
      const { agent } = agentWith([
        { tool: "start_task", input: { type: "booking", fields: { size: 4 } } },
        { reply: "For when?" },
      ])
      await agent.receiveAndWait(says("i want to book for four", "m1"))

      const task = (await agent.store.tasks.list({}, { orderBy: "seq" }))[0]
      expect(task).toMatchObject({ type: "booking", status: "active", fields: { size: 4 } })
      expect(task?.missing).toEqual(["date", "time"])
    })

    test("BUILTIN-2: a type nobody declared is refused, with the list", async () => {
      const { agent, brain } = agentWith([
        { tool: "start_task", input: { type: "haircut", fields: {} } },
        { reply: "I cannot do that." },
      ])
      await agent.receiveAndWait(says("book me a haircut", "m1"))

      expect(await agent.store.tasks.count()).toBe(0)
      const result = brain.calls[1]?.messages.at(-1) as { result?: { error?: string } }
      expect(result.result?.error).toContain("haircut")
      expect(result.result?.error).toContain("booking")
    })

    test("BUILTIN-2: update_task fills a field and recomputes what is missing", async () => {
      const { agent } = agentWith([
        { tool: "start_task", input: { type: "booking", fields: { size: 4 } } },
        { reply: "For when?" },
        { reply: "Done." },
      ])
      await agent.receiveAndWait(says("book for four", "m1"))
      const task = (await agent.store.tasks.list({}, { orderBy: "seq" }))[0]

      const { brain } = agentWith([])
      void brain
      // A second turn on the same agent, updating the task.
      agent.store.tasks.byId(task?.id ?? "")
      const updated = await agent.tools
        .get("update_task")
        ?.handler(
          { taskId: task?.id ?? "", fields: { date: "2026-10-23" } } as never,
          ctxFor(agent, task?.person_id ?? ""),
        )

      expect((updated as { task?: { missing?: string[] } }).task?.missing).toEqual(["time"])
    })

    test("BUILTIN-2: a field the type does not declare is refused, not stored", async () => {
      // `missing` could never account for it, so storing it would make the
      // task look fuller than it is.
      const { agent, brain } = agentWith([
        { tool: "start_task", input: { type: "booking", fields: { size: 4 } } },
        { reply: "Noted." },
      ])
      await agent.receiveAndWait(says("book for four", "m1"))
      const task = (await agent.store.tasks.list({}, { orderBy: "seq" }))[0]

      const out = (await agent.tools
        .get("update_task")
        ?.handler(
          { taskId: task?.id ?? "", fields: { favourite_colour: "green" } } as never,
          ctxFor(agent, task?.person_id ?? ""),
        )) as { ok?: boolean; error?: string }

      expect(out.ok).toBe(false)
      expect(out.error).toContain("favourite_colour")
      expect((await agent.store.tasks.byId(task?.id ?? ""))?.fields).toEqual({ size: 4 })
      void brain
    })

    test("LOOP-7: the brain is shown each open task and what is missing", async () => {
      const { agent, brain } = agentWith([
        { tool: "start_task", input: { type: "booking", fields: { size: 4 } } },
        { reply: "For when?" },
        { reply: "Still for when?" },
      ])
      await agent.receiveAndWait(says("book for four", "m1"))
      await agent.receiveAndWait(says("hello again", "m2"))

      const system = brain.calls[2]?.system ?? ""
      expect(system).toContain("# Open tasks")
      expect(system).toContain("booking (active)")
      expect(system).toContain("still missing: date, time")
      expect(system).toContain("never decide a task is complete yourself")
    })
  })

  describe("section 10: several open, one active", () => {
    test("switch_task makes another open task the active one", async () => {
      const { agent } = agentWith([
        { tool: "start_task", input: { type: "booking", fields: { size: 2 } } },
        { reply: "One." },
        { tool: "start_task", input: { type: "booking", fields: { size: 8 } } },
        { reply: "Two." },
      ])
      await agent.receiveAndWait(says("book for two", "m1"))
      await agent.receiveAndWait(says("and another for eight", "m2"))

      let tasks = await agent.store.tasks.list({}, { orderBy: "seq" })
      expect(tasks.map((task) => task.status)).toEqual(["open", "active"])

      const ctx = ctxFor(agent, tasks[0]?.person_id ?? "")
      await agent.tools.get("switch_task")?.handler({ taskId: tasks[0]?.id ?? "" } as never, ctx)

      tasks = await agent.store.tasks.list({}, { orderBy: "seq" })
      expect(tasks.map((task) => task.status)).toEqual(["active", "open"])
    })

    test("a task id from another person is not this person's to touch", async () => {
      const { agent } = agentWith([
        { tool: "start_task", input: { type: "booking", fields: { size: 2 } } },
        { reply: "One." },
      ])
      await agent.receiveAndWait(says("book for two", "m1"))
      const task = (await agent.store.tasks.list({}, { orderBy: "seq" }))[0]

      const out = (await agent.tools
        .get("switch_task")
        ?.handler(
          { taskId: task?.id ?? "" } as never,
          ctxFor(agent, "00000000-0000-0000-0000-000000000000"),
        )) as { ok?: boolean; error?: string }

      expect(out.ok).toBe(false)
      expect((await agent.store.tasks.byId(task?.id ?? ""))?.status).toBe("active")
    })

    test("close_task marks it done, and it stops being offered as open", async () => {
      const { agent, brain } = agentWith([
        { tool: "start_task", input: { type: "booking", fields: { size: 2 } } },
        { reply: "One." },
        { reply: "All done." },
      ])
      await agent.receiveAndWait(says("book for two", "m1"))
      const task = (await agent.store.tasks.list({}, { orderBy: "seq" }))[0]

      await agent.tools
        .get("close_task")
        ?.handler(
          { taskId: task?.id ?? "", outcome: "done" } as never,
          ctxFor(agent, task?.person_id ?? ""),
        )

      expect((await agent.store.tasks.byId(task?.id ?? ""))?.status).toBe("done")
      await agent.receiveAndWait(says("thanks", "m2"))
      expect(brain.calls[2]?.system ?? "").not.toContain("# Open tasks")
    })
  })

  describe("C14: a booking over five turns, with an interruption", () => {
    test("C14: five turns, an unrelated question in the middle, every field correct", async () => {
      // Driven a turn at a time, because the brain has to name the task id
      // the first turn created, exactly as a real one would read it out of
      // the runtime block.
      const brain = scriptedBrain([])
      sender = fakeSender()
      const agent = createAgent({
        config: config(),
        deps: {
          brains: [brain],
          decisionModel: scriptedDecisionModel([{ [GATE_QUESTION]: yesno(1) }]),
          db: localSupabase(),
          sender,
          clock,
        },
        prompt: PROMPT,
        tools: [bookTable, parking],
      })

      // 1. opens the task with the party size
      brain.push({ tool: "start_task", input: { type: "booking", fields: { size: 4 } } })
      brain.push({ reply: "Four. Which day?" })
      await agent.receiveAndWait(says("table for four please", "m1"))
      const task = (await agent.store.tasks.list({}, { orderBy: "seq" }))[0]
      const taskId = task?.id ?? ""
      expect(task?.missing).toEqual(["date", "time"])

      // 2. the date
      brain.push({ tool: "update_task", input: { taskId, fields: { date: "2026-10-23" } } })
      brain.push({ reply: "Friday. What time?" })
      await agent.receiveAndWait(says("friday", "m2"))
      expect((await agent.store.tasks.byId(taskId))?.missing).toEqual(["time"])

      // 3. the interruption, which touches no field
      brain.push({ tool: "parking", input: {} })
      brain.push({ reply: "Yes, 14 spaces." })
      await agent.receiveAndWait(says("is there parking?", "m3"))
      const afterDetour = await agent.store.tasks.byId(taskId)
      expect(afterDetour?.fields).toEqual({ size: 4, date: "2026-10-23" })
      expect(afterDetour?.missing).toEqual(["time"])

      // 4. the time, which completes it
      brain.push({ tool: "update_task", input: { taskId, fields: { time: "20:00" } } })
      brain.push({ reply: "Shall I book it?" })
      await agent.receiveAndWait(says("8pm", "m4"))
      expect((await agent.store.tasks.byId(taskId))?.missing).toEqual([])

      // 5. the booking itself, which needs a confirmation
      brain.push({
        tool: "book_table",
        input: { date: "2026-10-23", time: "20:00", size: 4 },
      })
      brain.push({ reply: "Please confirm." })
      await agent.receiveAndWait(says("yes please", "m5"))
      expect(booked).toEqual([])

      const action = (await agent.store.pendingActions.list({}, { orderBy: "seq" }))[0]
      expect(action?.summary).toBe("Table for 4 on 2026-10-23 at 20:00")

      brain.push({ reply: "Booked for four on Friday at 8pm." })
      await agent.receiveAndWait({
        ...says("Confirm", "m6"),
        action: {
          payload: buttonPayload("c", action?.id ?? "", action?.person_id ?? "", SECRET),
        },
      })

      // Every field correct, after an interruption in the middle.
      expect(booked).toEqual([{ date: "2026-10-23", time: "20:00", size: 4 }])
    })
  })

  describe("BUILTIN-3: idle expiry", () => {
    test("BUILTIN-3: a task nobody touched expires", async () => {
      const { agent } = agentWith([
        { tool: "start_task", input: { type: "booking", fields: { size: 4 } } },
        { reply: "Which day?" },
      ])
      await agent.receiveAndWait(says("book for four", "m1"))
      const task = (await agent.store.tasks.list({}, { orderBy: "seq" }))[0]

      clock.advance(25 * 60 * 60 * 1000)
      const job = (await agent.store.jobs.list({ kind: TASK_EXPIRE_JOB }))[0]
      expect(job).toBeDefined()
      await agent.jobs.run(job!)

      expect((await agent.store.tasks.byId(task?.id ?? ""))?.status).toBe("expired")
    })

    test("BUILTIN-3: a change pushes the window out, so the old job does nothing", async () => {
      const { agent } = agentWith([
        { tool: "start_task", input: { type: "booking", fields: { size: 4 } } },
        { reply: "Which day?" },
      ])
      await agent.receiveAndWait(says("book for four", "m1"))
      const task = (await agent.store.tasks.list({}, { orderBy: "seq" }))[0]
      const taskId = task?.id ?? ""
      const firstJob = (await agent.store.jobs.list({ kind: TASK_EXPIRE_JOB }))[0]

      // 20 hours later the person says something, which resets the window.
      clock.advance(20 * 60 * 60 * 1000)
      await agent.tools
        .get("update_task")
        ?.handler(
          { taskId, fields: { date: "2026-10-23" } } as never,
          ctxFor(agent, task?.person_id ?? ""),
        )

      // The original job comes due and finds the task no longer idle.
      clock.advance(5 * 60 * 60 * 1000)
      await agent.jobs.run(firstJob!)
      expect((await agent.store.tasks.byId(taskId))?.status).toBe("active")

      // The job scheduled by the change is the one that gets it.
      const jobs = await agent.store.jobs.list({ kind: TASK_EXPIRE_JOB }, { orderBy: "seq" })
      expect(jobs.length).toBeGreaterThan(1)
      clock.advance(20 * 60 * 60 * 1000)
      await agent.jobs.run(jobs.at(-1)!)
      expect((await agent.store.tasks.byId(taskId))?.status).toBe("expired")
    })

    test("BUILTIN-3: expiry takes the task's pending action with it", async () => {
      const { agent } = agentWith([
        { tool: "start_task", input: { type: "booking", fields: { size: 4 } } },
        { reply: "Which day?" },
      ])
      await agent.receiveAndWait(says("book for four", "m1"))
      const task = (await agent.store.tasks.list({}, { orderBy: "seq" }))[0]

      // A pending action on that task, as the gate would make once tasks
      // and the gate meet.
      const person = await agent.store.people.find({ channel_user_id: "42" })
      const action = await agent.store.pendingActions.insert({
        person_id: person?.id ?? "",
        task_id: task?.id ?? "",
        tool: "book_table",
        args: { size: 4 },
        args_hash: "x",
        summary: "Table for 4",
        code: "1234",
        status: "pending",
        expires_at: new Date(clock.now().getTime() + 900_000).toISOString(),
      })

      clock.advance(25 * 60 * 60 * 1000)
      const job = (await agent.store.jobs.list({ kind: TASK_EXPIRE_JOB }))[0]
      await agent.jobs.run(job!)

      expect((await agent.store.pendingActions.byId(action.id))?.status).toBe("cancelled")
    })

    test("BUILTIN-3: closing a task cancels the pending action on it", async () => {
      // A booking the person gave up on must not leave a Confirm button
      // sitting in their chat that still works.
      const { agent } = agentWith([
        { tool: "start_task", input: { type: "booking", fields: { size: 4 } } },
        { reply: "Which day?" },
      ])
      await agent.receiveAndWait(says("book for four", "m1"))
      const task = (await agent.store.tasks.list({}, { orderBy: "seq" }))[0]
      const person = await agent.store.people.find({ channel_user_id: "42" })

      const action = await agent.store.pendingActions.insert({
        person_id: person?.id ?? "",
        task_id: task?.id ?? "",
        tool: "book_table",
        args: { size: 4 },
        args_hash: "x",
        summary: "Table for 4",
        code: "1234",
        status: "pending",
        expires_at: new Date(clock.now().getTime() + 900_000).toISOString(),
      })

      await agent.tools
        .get("close_task")
        ?.handler(
          { taskId: task?.id ?? "", outcome: "cancelled" } as never,
          ctxFor(agent, person?.id ?? ""),
        )

      const now = await agent.store.pendingActions.byId(action.id)
      expect(now?.status).toBe("cancelled")
      expect(now?.error).toContain("cancelled")
    })

    test("CONF-6: changing a task's fields cancels the pending action on it", async () => {
      // The person agreed to a table for four. The brain has since learned
      // it is six, so the thing they agreed to is not the thing that would
      // happen.
      const { agent } = agentWith([
        { tool: "start_task", input: { type: "booking", fields: { size: 4 } } },
        { reply: "Which day?" },
      ])
      await agent.receiveAndWait(says("book for four", "m1"))
      const task = (await agent.store.tasks.list({}, { orderBy: "seq" }))[0]
      const person = await agent.store.people.find({ channel_user_id: "42" })

      const action = await agent.store.pendingActions.insert({
        person_id: person?.id ?? "",
        task_id: task?.id ?? "",
        tool: "book_table",
        args: { size: 4 },
        args_hash: "x",
        summary: "Table for 4",
        code: "1234",
        status: "pending",
        expires_at: new Date(clock.now().getTime() + 900_000).toISOString(),
      })

      await agent.tools
        .get("update_task")
        ?.handler(
          { taskId: task?.id ?? "", fields: { size: 6 } } as never,
          ctxFor(agent, person?.id ?? ""),
        )

      const now = await agent.store.pendingActions.byId(action.id)
      expect(now?.status).toBe("cancelled")
      expect(now?.error).toContain("fields changed")
    })
  })
})
