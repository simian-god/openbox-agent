// HAND-4 and HAND-5: the two directions a message travels while a
// handover is open, and the focus that decides which conversation an
// operator's words belong to.
//
// These tests are written around the two ways a relay goes wrong, and
// both are worse than a bug in the brain. Words meant for one customer
// reach another, or a colleague types a reply and the person never sees
// it. So every test here asks who received what, by name, rather than
// only that something was sent.
import { test, expect, describe, beforeAll, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { migrate } from "../../src/migrate/index.ts"
import { type Agent, type AgentOptions } from "../../src/runtime/index.ts"
import {
  asCommand,
  forwardText,
  isCommand,
  PERSON_TOLD,
  WANTS_HUMAN,
} from "../../src/runtime/handover.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { argsHash } from "../../src/runtime/confirm.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool } from "../../src/tools/index.ts"
import { scriptedBrain, type ScriptedStep } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import type {
  Brain,
  BrainInput,
  BrainMessage,
  BrainOutput,
} from "../../src/providers/brains/types.ts"
import type { HandoverRow, PersonRow } from "../../src/store/index.ts"

const SECRET = "test-secret-long-enough-to-look-real"
const PROMPT = "You are the host at a restaurant."
const SUMMARY = "They want a table.\nThe agent could not help.\nThey are waiting."

const agents = trackAgents("relay.test.ts")

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

/**
 * An irreversible tool for an operator, so the agent has a confirmation
 * path to get wrong. Never called in these tests: what matters is that
 * CONF-2's code can be typed, and must not be read out of a relay.
 */
const purge = defineTool({
  name: "purge_bookings",
  description: "Deletes every booking for a day.",
  input: z.object({ day: z.string() }),
  risk: "irreversible",
  roles: ["operator"],
  conditions: {
    callWhen: ["an operator asked for a day to be cleared"],
    dontCallWhen: ["anyone else asked"],
  },
  examples: { should: ["clear Monday"], shouldNot: ["hello"] },
  confirmSummary: (args) => `Delete every booking on ${args.day}`,
  handler: async () => ({ purged: true }),
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

describeDatabase("relay", (sql) => {
  const clock = fixedClock("2026-10-19T06:00:00Z")
  let sender: FakeSender

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  interface Built {
    agent: Agent
    calls: BrainInput[]
  }

  function build(
    script: ScriptedStep[],
    options: { started?: boolean; confirmable?: boolean } = {},
  ): Built {
    const { brain, calls } = testBrain(script)
    sender = fakeSender()
    const made: AgentOptions = {
      secret: SECRET,
      config: config(),
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
      tools: options.confirmable === true ? [table, purge] : [table],
    }
    const agent = options.started === false ? agents.build(made) : agents.create(made)
    return { agent, calls }
  }

  const from = (who: string, text: string, id = `m-${who}-${text.slice(0, 10)}`) => ({
    channel: "whatsapp",
    channelUserId: who,
    channelMessageId: id,
    text,
  })

  /** An operator who has already been made one (ROLE-2). */
  const operator = (agent: Agent, id: string, name?: string): Promise<PersonRow> =>
    agent.store.people.insert({
      channel: "whatsapp",
      channel_user_id: id,
      role: "operator",
      ...(name !== undefined ? { display_name: name } : {}),
    })

  /** A person in a waiting handover, opened by the brain's `escalate`. */
  async function waiting(
    agent: Agent,
    who = "9",
    name = "Riya",
  ): Promise<{ person: PersonRow; handover: HandoverRow }> {
    await agent.store.people.insert({
      channel: "whatsapp",
      channel_user_id: who,
      display_name: name,
    })
    await agent.receiveAndWait(from(who, "get me a manager"))
    const person = await agent.store.people.find({ channel_user_id: who })
    const handover = await agent.store.handovers.find({ person_id: person?.id ?? "" })
    return { person: person as PersonRow, handover: handover as HandoverRow }
  }

  /** What the brain was given, for the messages that are words. */
  const said = (one: BrainMessage): string => ("text" in one ? one.text : "")

  /** What one person received, in order. */
  const to = (who: string): string[] =>
    sender.sent.filter((out) => out.channelUserId === who).map((out) => out.text ?? "")

  describe("HAND-5: the person's words reach the operators", () => {
    test("HAND-5: while it is waiting, every operator gets what the person says", async () => {
      const { agent } = build([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
      ])
      await operator(agent, "op-1", "Asha")
      await operator(agent, "op-2", "Ravi")
      const { person } = await waiting(agent)
      sender.reset()

      await agent.receiveAndWait(from("9", "is anyone there?", "m-2"))

      const text = forwardText(person, "is anyone there?")
      expect(to("op-1")).toEqual([text])
      expect(to("op-2")).toEqual([text])
      // The person hears nothing from the agent, which is the rule this
      // forwarding exists to make bearable.
      expect(to("9")).toEqual([])
    })

    test("HAND-5: the forward says who it is from, and their words exactly", async () => {
      const { agent } = build([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
      ])
      await operator(agent, "op-1", "Asha")
      await waiting(agent)
      sender.reset()

      await agent.receiveAndWait(from("9", "I need this by 7pm, 4 people", "m-2"))

      const [forwarded] = to("op-1")
      expect(forwarded).toContain("Riya (whatsapp 9)")
      expect(forwarded).toContain("I need this by 7pm, 4 people")
    })

    test("HAND-5: once it is taken, only the operator who has it gets it", async () => {
      const { agent } = build([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
      ])
      const asha = await operator(agent, "op-1", "Asha")
      await operator(agent, "op-2", "Ravi")
      await waiting(agent)
      await agent.handovers.takeOver({ operator: asha })
      // Drained first, so HAND-3's note to Ravi about who took it is
      // not read below as a forward.
      await agent.outbox.pump.drain()
      sender.reset()

      await agent.receiveAndWait(from("9", "hello?", "m-2"))

      expect(to("op-1")).toHaveLength(1)
      // Ravi was told who took it (HAND-3). He is not reading it too.
      expect(to("op-2")).toEqual([])
    })

    test("HAND-5: a person in a handover is still stored and still not answered", async () => {
      const { agent, calls } = build([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
      ])
      await operator(agent, "op-1", "Asha")
      await waiting(agent)
      const before = calls.length
      sender.reset()

      const result = await agent.receiveAndWait(from("9", "hello?", "m-2"))

      expect(result.turn?.outcome).toBe("handover")
      expect(calls).toHaveLength(before)
      const messages = await agent.store.messages.list({}, { orderBy: "seq" })
      expect(messages.map((row) => row.text)).toContain("hello?")
    })

    test("HAND-5: the same message is never forwarded twice", async () => {
      const { agent } = build([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
      ])
      await operator(agent, "op-1", "Asha")
      const { person, handover } = await waiting(agent)
      sender.reset()

      const items = [{ id: "inbox-row-1", text: "hello?" }]
      const first = await agent.handovers.forward({ handover, person, items })
      const again = await agent.handovers.forward({ handover, person, items })

      expect(first).toBe(1)
      expect(again).toBe(1)
      await agent.outbox.pump.drain()
      // Queued twice, sent once: the key is the message, not the turn.
      expect(to("op-1")).toHaveLength(1)
    })

    test("HAND-5: two messages are two forwards, not one", async () => {
      const { agent } = build([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
      ])
      await operator(agent, "op-1", "Asha")
      const { person } = await waiting(agent)
      sender.reset()

      await agent.receiveAndWait(from("9", "hello?", "m-2"))
      await agent.receiveAndWait(from("9", "still there?", "m-3"))

      // Keyed by the message, so two messages are two forwards. Keyed by
      // the turn or the handover, the second one would vanish.
      expect(to("op-1")).toEqual([
        forwardText(person, "hello?"),
        forwardText(person, "still there?"),
      ])
    })

    test("HAND-5: with no operators, nothing is sent and nothing is lost", async () => {
      const { agent } = build([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
      ])
      await waiting(agent)
      sender.reset()

      await agent.receiveAndWait(from("9", "hello?", "m-2"))

      expect(sender.sent).toEqual([])
      const messages = await agent.store.messages.list({}, { orderBy: "seq" })
      expect(messages.map((row) => row.text)).toContain("hello?")
    })
  })

  describe("HAND-4: the operator's words reach the person", () => {
    /** An active handover, held and focused by Asha. */
    async function active(script: ScriptedStep[] = []): Promise<{
      agent: Agent
      calls: BrainInput[]
      asha: PersonRow
      person: PersonRow
    }> {
      const { agent, calls } = build([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
        ...script,
      ])
      const asha = await operator(agent, "op-1", "Asha")
      const { person } = await waiting(agent)
      await agent.handovers.takeOver({ operator: asha })
      await agent.outbox.pump.drain()
      sender.reset()
      return { agent, calls, asha, person }
    }

    test("HAND-4: a focused operator's words go to the person, word for word", async () => {
      const { agent, calls } = await active()
      const before = calls.length
      const decisions = await agent.store.decisions.count()
      const words = "Hi Riya, 7pm is fine. I have put you down for 4 :)"

      const result = await agent.receiveAndWait(from("op-1", words))

      expect(to("9")).toEqual([words])
      expect(result.turn?.outcome).toBe("relayed")
      // No brain call, no decision request, nothing spent. A colleague
      // typing should cost what typing costs.
      expect(calls).toHaveLength(before)
      expect(result.turn?.costUsd).toBe(0)
      expect(await agent.store.decisions.count()).toBe(decisions)
    })

    test("HAND-4: the operator hears nothing back from the agent", async () => {
      const { agent } = await active()

      await agent.receiveAndWait(from("op-1", "on it now"))

      expect(to("op-1")).toEqual([])
    })

    test("HAND-4: what they said is in the person's history, as the operator", async () => {
      const { agent, person } = await active()

      await agent.receiveAndWait(from("op-1", "7pm is fine"))

      const theirs = await agent.store.messages.list({ person_id: person.id }, { orderBy: "seq" })
      const relayed = theirs.filter((row) => row.author === "operator")
      expect(relayed.map((row) => row.text)).toEqual(["7pm is fine"])
      expect(relayed[0]?.direction).toBe("outbound")
    })

    test("HAND-7: the brain reads the operator's messages when it gets them back", async () => {
      const { agent, asha, calls } = await active([{ reply: "How else can I help?" }])
      await agent.receiveAndWait(from("op-1", "7pm is fine"))
      await agent.handovers.resume({ operator: asha })
      const before = calls.length

      await agent.receiveAndWait(from("9", "thanks", "m-thanks"))

      const asked = calls[before]
      expect(asked?.messages.some((one) => one.role === "operator")).toBe(true)
      expect(
        asked?.messages.some((one) => one.role === "operator" && said(one) === "7pm is fine"),
      ).toBe(true)
    })

    test("HAND-4: a message starting with a slash goes to the agent, not the person", async () => {
      const { agent, calls } = await active([{ reply: "Nothing else is waiting." }])
      const before = calls.length

      const result = await agent.receiveAndWait(from("op-1", "/what else is waiting?"))

      expect(to("9")).toEqual([])
      expect(to("op-1")).toEqual(["Nothing else is waiting."])
      expect(result.turn?.outcome).toBe("replied")
      // The slash is addressing, not content.
      const asked = calls[before]
      const last = asked?.messages.at(-1)
      expect(last === undefined ? "" : said(last)).toBe("what else is waiting?")
    })

    test("HAND-4: the brain is told which conversation this operator is on", async () => {
      const { agent, calls } = await active([{ reply: "You are on Riya." }])
      const before = calls.length

      await agent.receiveAndWait(from("op-1", "/who am I on?"))

      expect(calls[before]?.system).toContain("The handover you are on")
      expect(calls[before]?.system).toContain("Riya (whatsapp 9)")
    })

    test("HAND-4: a slash inside a sentence is not a command", async () => {
      // "we close 2/3 of the year" is a sentence somebody will send.
      const { agent } = await active()

      await agent.receiveAndWait(from("op-1", "we are shut 2/3 of August, sorry"))

      expect(to("9")).toEqual(["we are shut 2/3 of August, sorry"])
    })

    test("HAND-4: in one burst, the words are relayed and only the command is answered", async () => {
      const { agent, calls } = build([{ reply: "Given back to the agent." }], {
        started: false,
      })
      const asha = await operator(agent, "op-1", "Asha")
      // Opened through the module, so nothing has to run a turn before
      // both messages are written down.
      const riya = await agent.store.people.insert({
        channel: "whatsapp",
        channel_user_id: "9",
        display_name: "Riya",
      })
      await agent.handovers.open({ person: riya, reason: "operator" })
      await agent.handovers.takeOver({ operator: asha })
      await agent.outbox.pump.drain()
      sender.reset()

      // Two messages in one turn, which is the case a per-turn rule would
      // get wrong: the words belong to the person and the command does not.
      await agent.receive(from("op-1", "7pm is fine", "m-op-a"))
      await agent.receive(from("op-1", "/resume", "m-op-b"))
      const before = calls.length
      agent.start()
      await agent.settled()
      await agent.outbox.pump.drain()

      // PERSON_TOLD was queued by `open` above and goes out when the
      // worker starts, which is the one message here the agent sent.
      expect(to("9").filter((text) => text !== PERSON_TOLD)).toEqual(["7pm is fine"])
      const last = calls[before]?.messages.at(-1)
      expect(last === undefined ? "" : said(last)).toBe("resume")
      expect(calls[before]?.messages.some((one) => said(one) === "7pm is fine")).toBe(false)
    })

    test("CONF-4: a relayed message is never read as a confirmation", async () => {
      // An operator typing a party size to a customer, while something
      // of their own is waiting on a four digit code. The digits are
      // the customer's, not an answer to the agent.
      //
      // Sent as a burst with a command behind it, so the turn does reach
      // the confirmation path. A relay on its own never gets that far.
      const { agent } = build([{ reply: "Nothing to confirm." }], {
        confirmable: true,
        started: false,
      })
      const asha = await operator(agent, "op-1", "Asha")
      const riya = await agent.store.people.insert({
        channel: "whatsapp",
        channel_user_id: "9",
        display_name: "Riya",
      })
      await agent.handovers.open({ person: riya, reason: "operator" })
      await agent.handovers.takeOver({ operator: asha })
      const action = await agent.store.pendingActions.insert({
        person_id: asha.id,
        tool: "purge_bookings",
        args: { day: "monday" },
        args_hash: argsHash({ day: "monday" }),
        summary: "Delete every booking on Monday",
        code: "1234",
        status: "pending",
        expires_at: new Date(clock.now().getTime() + 600_000).toISOString(),
      })
      await agent.outbox.pump.drain()
      sender.reset()

      await agent.receive(from("op-1", "1234", "m-code"))
      await agent.receive(from("op-1", "/anything for me?", "m-ask"))
      agent.start()
      await agent.settled()
      await agent.outbox.pump.drain()

      expect(to("9").filter((text) => text !== PERSON_TOLD)).toEqual(["1234"])
      expect(to("op-1")).toContain("Nothing to confirm.")
      // One turn, both messages: a per-turn rule would be untested otherwise.
      expect(await agent.store.turns.count()).toBe(1)
      const still = await agent.store.pendingActions.byId(action.id)
      expect(still?.status).toBe("pending")
      // Not rejected either. The digits were never offered to the
      // confirmation path at all, which is the rule.
      expect(await agent.store.events.count({ name: "confirmation_received" })).toBe(0)
    })

    test("HAND-4: an operator with no handover is talking to the agent", async () => {
      const { agent, calls } = build([{ reply: "Nothing is waiting." }])
      await operator(agent, "op-1", "Asha")

      const result = await agent.receiveAndWait(from("op-1", "what is waiting?"))

      expect(result.turn?.outcome).toBe("replied")
      expect(to("op-1")).toEqual(["Nothing is waiting."])
      expect(calls).toHaveLength(1)
    })

    test("HAND-4: after resume, their words go to the agent again", async () => {
      const { agent, asha } = await active([{ reply: "They are back with me." }])
      await agent.handovers.resume({ operator: asha })

      const result = await agent.receiveAndWait(from("op-1", "all done there"))

      expect(result.turn?.outcome).toBe("replied")
      expect(to("9")).toEqual([])
      expect(to("op-1")).toEqual(["They are back with me."])
    })

    test("HAND-4: an operator whose handover somebody else holds is not relaying", async () => {
      // Ravi can write to the agent even though Asha is mid conversation.
      const { agent } = await active([{ reply: "Asha has that one." }])
      await operator(agent, "op-2", "Ravi")

      const result = await agent.receiveAndWait(from("op-2", "anything for me?"))

      expect(result.turn?.outcome).toBe("replied")
      expect(to("9")).toEqual([])
    })
  })

  describe("HAND-4: focus, when an operator holds two", () => {
    /** Asha holds two handovers: Riya, then Dev. */
    async function two(): Promise<{ agent: Agent; asha: PersonRow }> {
      const { agent } = build([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
        { tool: "escalate", input: { why: "they asked too" } },
        { reply: "Someone will be with you." },
      ])
      const asha = await operator(agent, "op-1", "Asha")
      const { person: riya } = await waiting(agent, "9", "Riya")
      const { person: dev } = await waiting(agent, "8", "Dev")
      await agent.handovers.takeOver({ operator: asha, person: riya })
      // A minute apart, because the focus is which one they turned to
      // last and two stamps in one millisecond would prove nothing.
      clock.advance(60_000)
      await agent.handovers.takeOver({ operator: asha, person: dev })
      await agent.outbox.pump.drain()
      sender.reset()
      return { agent, asha }
    }

    test("HAND-4: the one they turned to last is the one they are typing into", async () => {
      const { agent } = await two()

      await agent.receiveAndWait(from("op-1", "table for 2 at 8"))

      expect(to("8")).toEqual(["table for 2 at 8"])
      expect(to("9")).toEqual([])
    })

    test("HAND-4: taking one they already hold moves them back to it", async () => {
      const { agent, asha } = await two()
      const riya = await agent.store.people.find({ channel_user_id: "9" })
      clock.advance(60_000)

      const taken = await agent.handovers.takeOver({
        operator: asha,
        person: riya as PersonRow,
      })
      await agent.receiveAndWait(from("op-1", "yours is at 7"))

      expect(taken.kind).toBe("taken")
      expect(to("9")).toEqual(["yours is at 7"])
      expect(to("8")).toEqual([])
    })

    test("HAND-4: focus is only ever one of their own, and only an open one", async () => {
      const { agent, asha } = await two()
      const focus = await agent.handovers.focusOf(asha)
      const dev = await agent.store.people.byId(focus?.person_id ?? "")
      await agent.handovers.resume({ operator: asha, person: dev as PersonRow })

      // Dev was given back, so the focus falls to the one still open.
      const next = await agent.handovers.focusOf(asha)
      expect(next?.person_id).not.toBe(focus?.person_id)
      expect(next?.status).toBe("active")
    })

    test("HAND-4: an operator holding none has no focus", async () => {
      const { agent } = build([{ reply: "hello" }])
      const ravi = await operator(agent, "op-2", "Ravi")

      expect(await agent.handovers.focusOf(ravi)).toBeUndefined()
    })
  })

  describe("HAND-4 and HAND-5: both directions, one conversation", () => {
    test("HAND-5: the person answers the colleague, and the colleague sees it", async () => {
      const { agent } = build([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
      ])
      const asha = await operator(agent, "op-1", "Asha")
      const { person } = await waiting(agent)
      await agent.handovers.takeOver({ operator: asha })
      await agent.outbox.pump.drain()
      sender.reset()

      await agent.receiveAndWait(from("op-1", "7pm is fine, 4 people?"))
      await agent.receiveAndWait(from("9", "yes, 4", "m-yes"))
      await agent.receiveAndWait(from("op-1", "done, see you then", "m-op-2"))

      expect(to("9")).toEqual(["7pm is fine, 4 people?", "done, see you then"])
      expect(to("op-1")).toEqual([forwardText(person, "yes, 4")])
      // PERSON_TOLD was sent once, before all this, and never again.
      expect(sender.texts().filter((text) => text === PERSON_TOLD)).toHaveLength(0)
    })
  })

  describe("section 10: list_handovers", () => {
    test("HAND-3: an operator can see what is open and who is on each", async () => {
      const { agent } = build([
        { tool: "escalate", input: { why: "they asked" } },
        { reply: "Someone will be with you." },
        { tool: "list_handovers" },
        { reply: "One waiting from Riya." },
      ])
      const asha = await operator(agent, "op-1", "Asha")
      await waiting(agent)
      await agent.handovers.takeOver({ operator: asha })

      await agent.receiveAndWait(from("op-1", "/what is waiting?"))

      const [run] = await agent.store.toolRuns.list({ tool: "list_handovers" })
      const result = JSON.stringify(run?.result)
      expect(result).toContain("Riya (whatsapp 9)")
      expect(result).toContain('"status":"active"')
      expect(result).toContain('"with":"you"')
    })

    test("ROLE-3: an end user is never offered the operator's handover tools", async () => {
      const { agent } = build([{ reply: "We open at 11." }])

      await agent.receiveAndWait(from("9", "are you open?"))

      const theirs = agent.tools.builtinsForRole("end_user").map((tool) => tool.name)
      const ours = agent.tools.builtinsForRole("operator").map((tool) => tool.name)
      expect(theirs).toContain("escalate")
      expect(theirs).not.toContain("list_handovers")
      expect(theirs).not.toContain("take_over")
      expect(ours).toContain("list_handovers")
      expect(ours).not.toContain("escalate")
    })
  })

  describe("HAND-4: the slash itself", () => {
    test("HAND-4: what counts as a command, and what the brain reads", () => {
      expect(isCommand("/resume")).toBe(true)
      expect(isCommand("  /resume")).toBe(true)
      expect(isCommand("resume")).toBe(false)
      expect(isCommand("we shut 2/3 of August")).toBe(false)
      expect(isCommand("")).toBe(false)

      expect(asCommand("/resume")).toBe("resume")
      expect(asCommand("  /  resume please ")).toBe("resume please")
    })
  })
})
