// C19: the failure sweep. Each dependency failed in turn, then all at once.
//
// Every one of these failures already has tests of its own, written where
// that dependency lives. This file exists because C19 is not a claim about
// any one of them. It is a claim about all of them, measured on the same
// two bars:
//
//   nothing is lost      the message is linked to the turn that handled
//                        it, and it is marked done only if something was
//                        written down in answer to it
//   always an answer     the person gets a real answer or one of the two
//                        fixed holding lines, whichever the failure allows
//
// So the bars are one function here, `expectSwept`, applied to every case
// rather than whatever each dependency's own file happened to assert. A
// dependency that fails in a new way has to clear the same bar as the rest.
//
// The four dependencies are the ones C19 names: the brain, the decision
// model, a tool, and the sender. Then all four at once, then all four in
// turn inside one conversation, because four separate tests prove four
// separate turns and say nothing about a conversation carrying on.
//
// One case at the end is not a dependency failing but a bug: a `Sender`
// whose `capabilities` throws. It clears the first bar and not the second,
// which is where C19's second half stops today, and that is Known K30.
import { test, expect, describe, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { check } from "../support/waiting.ts"
import type { Agent, AgentOptions } from "../../src/runtime/index.ts"
import { BRAINS_FAILED_REPLY } from "../../src/runtime/limits.ts"
import { PERSON_TOLD } from "../../src/runtime/handover.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool, type Tool } from "../../src/tools/index.ts"
import { scriptedBrain } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { buttonPayload } from "../../src/runtime/confirm.ts"
import { systemClock } from "../../src/testing/clock.ts"
import type { Brain, BrainInput, BrainOutput } from "../../src/providers/brains/types.ts"
import {
  DecisionError,
  type DecisionModel,
  type DecisionResult,
  type Question,
} from "../../src/providers/decision/types.ts"
import type { Outbound, SendResult, Sender } from "../../src/runtime/sender.ts"

const SECRET = "test-secret-long-enough-to-look-real"
const PROMPT = "You are the host at a restaurant."

const agents = trackAgents("sweep.test.ts")

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
    // Short, so a sweep is not waiting out a real thirty second backoff.
    sendAttempts: 3,
    sendBackoffMs: 1,
    ...over,
  })
}

/** What each tool did, so a sweep can tell a decision from a consequence. */
let ran: string[] = []
let charged: unknown[] = []

/** Set per turn by the sweep that fails one dependency at a time. */
const broken = { brain: false, decision: false, tool: false, sender: false }

const readMenu = defineTool({
  name: "read_menu",
  description: "Reads the menu.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask about food"], dontCallWhen: ["they do not"] },
  examples: { should: ["what is on?"], shouldNot: ["hello"] },
  handler: async () => {
    ran.push("read_menu")
    return { items: ["dosa"] }
  },
})

/** The tool whose failure the sweep injects. */
const checkAvailability = defineTool({
  name: "check_availability",
  description: "Checks whether a table is free.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask about a table"], dontCallWhen: ["they do not"] },
  examples: { should: ["any space?"], shouldNot: ["hello"] },
  handler: async () => {
    ran.push("check_availability")
    throw new Error("the bookings system never answered")
  },
})

const updateBooking = defineTool({
  name: "update_booking",
  description: "Moves an existing booking.",
  input: z.object({ to: z.string() }),
  risk: "write",
  roles: ["end_user"],
  conditions: { callWhen: ["they want to move a booking"], dontCallWhen: ["they do not"] },
  examples: { should: ["move it to 9"], shouldNot: ["hello"] },
  handler: async (args) => {
    ran.push("update_booking")
    charged.push(args)
    return { moved: true }
  },
})

const bookTable = defineTool({
  name: "book_table",
  description: "Books a table, which cannot be undone.",
  input: z.object({ size: z.number().int().min(1) }),
  risk: "irreversible",
  roles: ["end_user"],
  conditions: {
    callWhen: ["the person has agreed to a table for a known number of people"],
    dontCallWhen: ["they are only asking whether a table is free"],
  },
  confirmSummary: (args) => `Table for ${args.size} on Friday at 20:00`,
  examples: { should: ["book it for four"], shouldNot: ["any space friday?"] },
  handler: async (args) => {
    ran.push("book_table")
    charged.push(args)
    return { booked: true }
  },
})

const TOOLS: Tool[] = [readMenu, checkAvailability, updateBooking, bookTable]

/**
 * Routing switched on, for the cases where the decision model is down.
 *
 * Four routable tools is under the default `routingMinTools` of 5, so
 * routing would never run and ROUTE-5 would never be reached: the case
 * would look like a pass while testing only the gate. Only used where the
 * model is down for the whole turn, so nothing can narrow anything.
 */
const ROUTING_ON = { routingMinTools: 1 }

interface Recording extends Sender {
  readonly tries: Outbound[]
}

/** A sender that is down. Every send throws, which is what a timeout does. */
function senderDown(idempotent = false): Recording {
  const tries: Outbound[] = []
  return {
    tries,
    capabilities: () => ({
      buttons: true,
      files: true,
      templates: false,
      idempotentSends: idempotent,
    }),
    async send(out: Outbound): Promise<SendResult> {
      tries.push(out)
      throw new Error("the gateway never answered")
    },
  }
}

/** A sender that delivers, except while `broken.sender` is set. */
function senderSwitchable(): Recording {
  const tries: Outbound[] = []
  let n = 0
  return {
    tries,
    capabilities: () => ({
      buttons: true,
      files: true,
      templates: false,
      idempotentSends: false,
    }),
    async send(out: Outbound): Promise<SendResult> {
      tries.push(out)
      if (broken.sender) throw new Error("the gateway never answered")
      n++
      return { status: "sent", channelMessageId: `ok-${n}` }
    },
  }
}

/** A brain that is simply down, however it is asked. */
const brainDown = (id: string): Brain => ({
  id,
  kind: "api",
  supportsImages: false,
  complete: () => Promise.reject(new Error(`${id} is down`)),
})

const USAGE = { inputTokens: 10, outputTokens: 5 }

/**
 * A brain for the one-at-a-time sweep.
 *
 * It throws while `broken.brain` is set, asks for the failing tool while
 * `broken.tool` is set, and otherwise answers. It reads the conversation
 * rather than a script because the same brain runs four turns and one of
 * them has a tool result in the middle of it.
 *
 * `honoursBreak` is false for the standby, so that breaking the brain
 * breaks one of the chain rather than all of it. All of it is the
 * all-at-once case, which is tested above.
 */
function switchableBrain(id: string, honoursBreak = true): Brain {
  return {
    id,
    kind: "api",
    supportsImages: false,
    async complete(input: BrainInput): Promise<BrainOutput> {
      if (honoursBreak && broken.brain) throw new Error(`${id} is down`)
      const last = input.messages[input.messages.length - 1]
      if (broken.tool && last?.role !== "tool_result") {
        return {
          toolCalls: [{ id: "c1", name: "check_availability", input: {} }],
          finishReason: "tool_calls",
          usage: USAGE,
        }
      }
      return { text: `${id} answered.`, finishReason: "stop", usage: USAGE }
    },
  }
}

/** A decision model that answers, except while `broken.decision` is set. */
function decisionSwitchable(): DecisionModel {
  const inner = scriptedDecisionModel([{ [GATE_QUESTION]: yesno(1) }])
  return {
    id: "switchable",
    async ask(state: unknown, questions: Record<string, Question>): Promise<DecisionResult> {
      if (broken.decision) throw new DecisionError("switchable", "the decision provider is down")
      return inner.ask(state, questions)
    },
  }
}

/** A decision model that is down, however it is asked. */
const decisionDown = () => scriptedDecisionModel([{ throws: "the decision provider is down" }])

/**
 * What the rows say happened, which is where both bars are decided.
 *
 * Read from the database rather than from the return value on purpose: a
 * turn that reports an answer it never wrote down has lost the message
 * just as surely as one that reports nothing.
 */
interface Swept {
  /** The inbox row for the message that was sent in. */
  inbox: { status: string; hasTurn: boolean }
  /** Everything written down for the person, whether or not it went out. */
  written: { kind: string; status: string; text: string }[]
  /** Of those, the ones that actually reached the channel. */
  delivered: string[]
  outcome: string | undefined
}

async function sweptState(
  agent: Agent,
  inboxId: string,
  outcome: string | undefined,
): Promise<Swept> {
  const row = await agent.store.inbox.byId(inboxId)
  const outbox = await agent.store.outbox.list({}, { orderBy: "seq", ascending: true })
  const written = outbox.map((out) => ({
    kind: out.kind,
    status: out.status,
    text: String((out.payload as { text?: unknown }).text ?? ""),
  }))
  return {
    inbox: { status: row?.status ?? "missing", hasTurn: row?.turn_id != null },
    written,
    delivered: written.filter((out) => out.status === "sent").map((out) => out.text),
    outcome,
  }
}

/**
 * C19's two bars, the same for every failure in this file.
 *
 * `expectSwept` is deliberately not told which dependency failed. A bar
 * that knows what broke is a bar per case, and C19 is one claim.
 */
function expectSwept(state: Swept): void {
  // Nothing lost. The message is attached to the turn that handled it, so
  // a trace can get from one to the other, and its status is one the
  // recovery sweep understands.
  expect(state.inbox.hasTurn).toBe(true)
  expect(["done", "failed"]).toContain(state.inbox.status)

  // Always an answer. Something was written down for the person: a real
  // answer, or one of the two fixed lines that promise one is coming.
  // Written down rather than delivered, because the sender is one of the
  // things that is allowed to be broken here.
  const replies = state.written.filter((out) => out.kind === "reply")
  expect(replies.length).toBeGreaterThan(0)
  expect(replies.every((out) => out.text.trim() !== "")).toBe(true)
}

describeDatabase("C19: the failure sweep", (sql) => {
  beforeEach(async () => {
    await resetDatabase(sql())
    ran = []
    charged = []
    broken.brain = false
    broken.decision = false
    broken.tool = false
    broken.sender = false
  })

  function agentWith(parts: {
    brains?: Brain[]
    decisionModel?: DecisionModel
    sender?: Sender
    tools?: Tool[]
    over?: Record<string, unknown>
  }): Agent {
    const options: AgentOptions = {
      secret: SECRET,
      config: config(parts.over ?? {}),
      deps: {
        brains: parts.brains ?? [scriptedBrain([{ reply: "We open at 11." }])],
        decisionModel:
          parts.decisionModel ?? scriptedDecisionModel([{ [GATE_QUESTION]: yesno(1) }]),
        db: localSupabase(),
        sender: parts.sender ?? senderSwitchable(),
        clock: systemClock,
      },
      prompt: PROMPT,
      tools: parts.tools ?? TOOLS,
    }
    return agents.create(options)
  }

  const hello = (over: Record<string, unknown> = {}) => ({
    channel: "whatsapp",
    channelUserId: "42",
    channelMessageId: "m1",
    text: "any space on monday?",
    ...over,
  })

  /** The person the sweep talks to, found the way a trace would find them. */
  async function personOf(agent: Agent): Promise<string> {
    const people = await agent.store.people.list({ channel_user_id: "42" })
    return people[0]?.id ?? "unknown"
  }

  describe("C19: the brain", () => {
    test("C19: every brain down, and the person still hears something", async () => {
      const agent = agentWith({ brains: [brainDown("first"), brainDown("second")] })

      const result = await agent.receiveAndWait(hello())
      const state = await sweptState(agent, result.inboxId, result.turn?.outcome)

      await check(agent, await personOf(agent), () => {
        expectSwept(state)
        // LOOP-12: the holding line, and then HAND-2's, because the
        // promise it just made needs an owner.
        expect(state.delivered).toEqual([BRAINS_FAILED_REPLY, PERSON_TOLD])
        // Nobody answered it, so it stays findable rather than done.
        expect(state.inbox.status).toBe("failed")
        expect(state.outcome).toBe("brains_failed")
      })
    })

    test("LOOP-12: and a colleague is given the promise the agent just made", async () => {
      const agent = agentWith({ brains: [brainDown("only")] })

      await agent.receiveAndWait(hello())

      const handovers = await agent.store.handovers.list({})
      expect(handovers).toHaveLength(1)
      expect(handovers[0]?.reason).toBe("brains_failed")
    })

    test("C19: one brain down out of two is not a failure at all", async () => {
      // The sweep's own control. If a chain with a live brain in it did
      // not simply answer, the case above would be measuring the chain
      // rather than the outage.
      const agent = agentWith({
        brains: [
          brainDown("first"),
          scriptedBrain([{ reply: "We open at 11." }], { id: "second" }),
        ],
      })

      const result = await agent.receiveAndWait(hello())
      const state = await sweptState(agent, result.inboxId, result.turn?.outcome)

      expectSwept(state)
      expect(state.delivered).toEqual(["We open at 11."])
      expect(state.inbox.status).toBe("done")
    })
  })

  describe("C19: the decision model", () => {
    test("C19: the decision model down, and the person is still answered", async () => {
      const agent = agentWith({
        decisionModel: decisionDown(),
        brains: [scriptedBrain([{ tool: "read_menu", input: {} }, { reply: "Dosa is on." }])],
        over: ROUTING_ON,
      })

      const result = await agent.receiveAndWait(hello())
      const state = await sweptState(agent, result.inboxId, result.turn?.outcome)

      await check(agent, await personOf(agent), () => {
        expectSwept(state)
        expect(state.delivered).toEqual(["Dosa is on."])
        // ROUTE-5 failed open, so the read tool was still there to be
        // called, and GATE-5 means reading was never asked about.
        expect(ran).toEqual(["read_menu"])
        expect(state.outcome).toBe("replied")
      })
    })

    test("ROUTE-5: with no answer about which tools to offer, every tool is offered", async () => {
      const brain = scriptedBrain([{ reply: "We open at 11." }])
      const agent = agentWith({ decisionModel: decisionDown(), brains: [brain], over: ROUTING_ON })

      const result = await agent.receiveAndWait(hello())

      // Routing is an optimisation, and an unsure optimisation must not
      // put the right tool out of reach. Asserted as a superset, because
      // BUILTIN-1's tools are offered on every step whatever routing
      // says and so are there either way.
      const offered = brain.calls[0]?.tools.map((tool) => tool.name) ?? []
      for (const tool of TOOLS) expect(offered).toContain(tool.name)
      expect(result.turn?.routed[0]?.reason).toBe("fallback")
    })

    test("GATE-4: a write does not run while the gate cannot be answered", async () => {
      const agent = agentWith({
        decisionModel: decisionDown(),
        brains: [
          scriptedBrain([
            { tool: "update_booking", input: { to: "21:00" } },
            { reply: "Can I confirm moving it to 9?" },
          ]),
        ],
        over: ROUTING_ON,
      })

      const result = await agent.receiveAndWait(hello())
      const state = await sweptState(agent, result.inboxId, result.turn?.outcome)

      await check(agent, await personOf(agent), () => {
        expectSwept(state)
        // The gate fails closed, so nothing was moved, and the person
        // was still answered rather than left waiting.
        expect(charged).toEqual([])
        expect(state.delivered).toEqual(["Can I confirm moving it to 9?"])
      })
    })

    test("C19: a decision model outage never lets an irreversible tool run", async () => {
      // The one sentence C19 spells out, because it is the one where
      // failing open would cost somebody real money.
      const agent = agentWith({
        decisionModel: decisionDown(),
        brains: [
          scriptedBrain([
            { tool: "book_table", input: { size: 4 } },
            { reply: "I have asked them to confirm." },
          ]),
        ],
        over: ROUTING_ON,
      })

      const result = await agent.receiveAndWait(hello())
      const state = await sweptState(agent, result.inboxId, result.turn?.outcome)

      await check(agent, await personOf(agent), () => {
        expect(charged).toEqual([])
        expect(ran).not.toContain("book_table")
        expectSwept(state)
      })
    })

    test("GATE-4: and the irreversible call is still put to the person", async () => {
      // GATE-4: "an irreversible call still needs a structured confirm,
      // which never depends on the decision model". The gate's answer was
      // never what made that call safe, the person's own confirmation is,
      // so an outage must not turn a booking into a refusal.
      const agent = agentWith({
        decisionModel: decisionDown(),
        brains: [
          scriptedBrain([
            { tool: "book_table", input: { size: 4 } },
            { reply: "I have asked them to confirm." },
          ]),
        ],
        over: ROUTING_ON,
      })

      await agent.receiveAndWait(hello())

      const pending = await agent.store.pendingActions.list({})
      expect(pending).toHaveLength(1)
      expect(pending[0]?.tool).toBe("book_table")
      expect(pending[0]?.status).toBe("pending")
      // And the person was asked, with the summary they are agreeing to.
      const confirms = await agent.store.outbox.list({ kind: "confirm" })
      expect(confirms).toHaveLength(1)
      expect(String((confirms[0]?.payload as { text?: unknown }).text)).toContain("Table for 4")
    })

    test("CONF-4: an action asked for during an outage is no weaker than any other", async () => {
      // The whole argument for asking during an outage is that the
      // person's own confirm is the authority. That only holds if the
      // action created this way is held to every CONF-4 rule, so this
      // attacks it the same way C9 attacks the ordinary one.
      const agent = agentWith({
        decisionModel: decisionDown(),
        brains: [
          scriptedBrain([
            { tool: "book_table", input: { size: 4 } },
            { reply: "I have asked them to confirm." },
            { reply: "I still need you to confirm." },
          ]),
        ],
        over: ROUTING_ON,
      })
      await agent.receiveAndWait(hello())
      const action = (await agent.store.pendingActions.list({}))[0]

      // The stolen payload from C9: the real button, signed for the person
      // it was made for, tapped by somebody else.
      //
      // What rejects it is the signature, because CONF-3 keys the HMAC on
      // the person id, so a valid payload for one person is invalid in
      // anybody else's hands. CONF-4's own same person rule sits behind
      // that as defence in depth, and taking it away changes nothing
      // here, which was worth finding out.
      await agent.receiveAndWait(
        hello({
          channelMessageId: "m2",
          channelUserId: "99",
          text: "yes",
          action: {
            payload: buttonPayload("c", action?.id ?? "", action?.person_id ?? "", SECRET),
          },
        }),
      )

      expect(charged).toEqual([])
      const after = await agent.store.pendingActions.byId(action?.id ?? "")
      expect(after?.status).toBe("pending")
    })

    test("GATE-4: a write is still only treated as Confirm, and asks nobody", async () => {
      // The narrowing to irreversible is load bearing. A write that
      // failed closed is for the brain to raise in words, which is what
      // GATE-4 says, and a signed button for it would be CONF-1 applied
      // to a tool that never asked for one.
      const agent = agentWith({
        decisionModel: decisionDown(),
        brains: [
          scriptedBrain([
            { tool: "update_booking", input: { to: "21:00" } },
            { reply: "Shall I move it to 9?" },
          ]),
        ],
        over: ROUTING_ON,
      })

      await agent.receiveAndWait(hello())

      expect(await agent.store.pendingActions.count({})).toBe(0)
      expect(await agent.store.outbox.count({ kind: "confirm" })).toBe(0)
      expect(charged).toEqual([])
    })
  })

  describe("C19: a tool", () => {
    test("C19: a tool that throws is answered around, not passed on", async () => {
      const brain = scriptedBrain([
        { tool: "check_availability", input: {} },
        { reply: "I cannot see the diary, shall I call you back?" },
      ])
      const agent = agentWith({ brains: [brain] })

      const result = await agent.receiveAndWait(hello())
      const state = await sweptState(agent, result.inboxId, result.turn?.outcome)

      await check(agent, await personOf(agent), () => {
        expectSwept(state)
        expect(ran).toEqual(["check_availability"])
        // LOOP-10: the error went back to the brain as a result. Read off
        // what the second step was actually given, because a scripted
        // brain replies whatever it was told: a swallowed error would
        // otherwise leave this test green while the brain was lied to.
        const told = brain.calls[1]?.messages.filter((m) => m.role === "tool_result") ?? []
        expect(told).toHaveLength(1)
        expect(told[0]).toMatchObject({
          name: "check_availability",
          result: null,
          error: "the bookings system never answered",
        })
        // And the brain's answer is what the person got.
        expect(state.delivered).toEqual(["I cannot see the diary, shall I call you back?"])
        expect(state.inbox.status).toBe("done")
      })
    })

    test("LOOP-10: the same tool failing twice in a row is a handover", async () => {
      const agent = agentWith({
        brains: [
          scriptedBrain([
            { tool: "check_availability", input: {} },
            { tool: "check_availability", input: {} },
            { reply: "Let me get somebody to look." },
          ]),
        ],
      })

      const result = await agent.receiveAndWait(hello())
      const state = await sweptState(agent, result.inboxId, result.turn?.outcome)
      const handovers = await agent.store.handovers.list({})

      await check(agent, await personOf(agent), () => {
        expectSwept(state)
        expect(ran).toEqual(["check_availability", "check_availability"])
        expect(handovers).toHaveLength(1)
        expect(handovers[0]?.reason).toBe("tool_failed_repeat")
      })
    })

    test("LEARN-1: a tool error is flagged, so a builder reads about it", async () => {
      const agent = agentWith({
        brains: [
          scriptedBrain([
            { tool: "check_availability", input: {} },
            { reply: "Sorry about that." },
          ]),
        ],
      })

      await agent.receiveAndWait(hello())

      const flags = await agent.store.flags.list({})
      expect(flags.map((flag) => flag.kind)).toContain("tool_error")
    })
  })

  describe("C19: the sender", () => {
    test("C19: the sender down leaves the answer written down, not lost", async () => {
      const sender = senderDown()
      const agent = agentWith({ sender })

      const result = await agent.receiveAndWait(hello())
      const state = await sweptState(agent, result.inboxId, result.turn?.outcome)

      await check(agent, await personOf(agent), () => {
        expectSwept(state)
        // Nothing reached the channel, and the answer is still a row with
        // its text in it, which is what makes it recoverable.
        expect(state.delivered).toEqual([])
        expect(state.written[0]?.text).toBe("We open at 11.")
        // A thrown send may have arrived, so it is unknown rather than
        // failed, and on a channel where a repeat would be seen it is not
        // said a second time.
        expect(state.written[0]?.status).toBe("unknown")
        expect(sender.tries).toHaveLength(1)
      })
    })

    test("C19: on a channel where a repeat is invisible, it is tried again", async () => {
      const sender = senderDown(true)
      const agent = agentWith({ sender })

      const result = await agent.receiveAndWait(hello())
      const state = await sweptState(agent, result.inboxId, result.turn?.outcome)

      await check(agent, await personOf(agent), () => {
        expectSwept(state)
        expect(sender.tries).toHaveLength(3)
        expect(state.written[0]?.status).toBe("unknown")
      })
    })
  })

  describe("C19: all at once", () => {
    test("C19: everything down, and the message is still not lost", async () => {
      // The decision model cannot be reached, no brain answers, the tool
      // would throw if anything got that far, and nothing can be sent.
      const sender = senderDown()
      const agent = agentWith({
        decisionModel: decisionDown(),
        brains: [brainDown("first"), brainDown("second")],
        sender,
        over: ROUTING_ON,
      })

      const result = await agent.receiveAndWait(hello())
      const state = await sweptState(agent, result.inboxId, result.turn?.outcome)

      await check(agent, await personOf(agent), () => {
        expectSwept(state)
        expect(state.outcome).toBe("brains_failed")
        // Nothing reached anybody, and everything is written down: the
        // holding line for the person and the alert for a colleague.
        expect(state.delivered).toEqual([])
        expect(state.written[0]?.text).toBe(BRAINS_FAILED_REPLY)
        // The row stays findable, which is the whole of "not lost".
        expect(state.inbox.status).toBe("failed")
      })
    })

    test("C19: with everything down the handover is still opened", async () => {
      // The alert cannot go out, and that must not be the reason the
      // handover is never recorded: the row is what a colleague finds.
      const agent = agentWith({
        decisionModel: decisionDown(),
        brains: [brainDown("only")],
        sender: senderDown(),
        over: ROUTING_ON,
      })

      await agent.receiveAndWait(hello())

      const handovers = await agent.store.handovers.list({})
      expect(handovers).toHaveLength(1)
      // Waiting, which is HAND-3's "nobody has taken it yet", not closed
      // and not lost. HAND-6's clock is now running on it.
      expect(handovers[0]?.status).toBe("waiting")
    })

    test("C19: and nothing is thrown back at the channel", async () => {
      // A webhook that gets a 500 is a webhook that will be delivered
      // again. Whatever is down inside, `receive` has to come back clean.
      const agent = agentWith({
        decisionModel: decisionDown(),
        brains: [brainDown("only")],
        sender: senderDown(),
        over: ROUTING_ON,
      })

      const result = await agent.receive(hello())
      await agent.settled()

      expect(result.duplicate).toBe(false)
      const row = await agent.store.inbox.byId(result.inboxId)
      expect(row?.status).toBe("failed")
      expect(row?.turn_id).not.toBeNull()
    })
  })

  describe("C19: a dependency broken in a way nothing expected", () => {
    test("C19: the row stays findable, and this is where C19's second half stops", async () => {
      // Everything above is a failure the core has a plan for. This is
      // one it has none for: a channel adapter whose `capabilities`
      // throws, which the core reads inside the turn when it is about to
      // ask somebody to confirm something.
      //
      // It clears the first bar and not the second, so it does not go
      // through `expectSwept`. The row stays findable and
      // `receiveAndWait` comes back clean, and the person is told
      // nothing at all: LOOP-12's holding message is written for the two
      // outcomes the Spec names and this is not one of them. The
      // recovery sweep will not pick it up either, because it looks for
      // turns that were abandoned rather than turns that failed. Known
      // K30, which is the builder's to settle.
      const buggy: Sender = {
        capabilities: () => {
          throw new Error("the channel adapter has a bug")
        },
        send: async () => ({ status: "sent", channelMessageId: "x" }),
      }
      const errors: unknown[] = []
      const agent = agents.create({
        secret: SECRET,
        config: config(),
        deps: {
          brains: [
            scriptedBrain([
              { tool: "book_table", input: { size: 4 } },
              { reply: "Asked them to confirm." },
            ]),
          ],
          decisionModel: scriptedDecisionModel([{ [GATE_QUESTION]: yesno(1) }]),
          db: localSupabase(),
          sender: buggy,
          clock: systemClock,
        },
        prompt: PROMPT,
        tools: TOOLS,
        onTurnError: (failure) => errors.push(failure.error),
      })

      const result = await agent.receiveAndWait(hello())

      // Bar one, nothing lost: the row is findable and linked to the
      // turn that failed on it.
      const row = await agent.store.inbox.byId(result.inboxId)
      expect(row?.status).toBe("failed")
      expect(row?.turn_id).not.toBeNull()
      expect(result.turn?.outcome).toBe("failed")
      // And the builder hears about it, which is the only thing that
      // does happen.
      expect(errors).toHaveLength(1)
      // Bar two, not cleared: nothing was written for the person. This
      // is pinned rather than wished, so a fix shows up here as a
      // failing test rather than going unnoticed.
      expect(await agent.store.outbox.count({ kind: "reply" })).toBe(0)
      // Nothing irreversible ran on the way past, which is the one thing
      // that would make this more than a lost answer.
      expect(charged).toEqual([])
    })
  })

  describe("C19: each in turn, in one conversation", () => {
    test("C19: four turns, one dependency broken in each, four answers", async () => {
      // Four separate tests prove four separate turns. This is one
      // person and four turns, with one dependency broken in each: a
      // conversation that survived one failure must not be poisoned for
      // the next, and the person is answered every time.
      const agent = agentWith({
        brains: [switchableBrain("primary"), switchableBrain("standby", false)],
        decisionModel: decisionSwitchable(),
        sender: senderSwitchable(),
      })

      const turns: { what: keyof typeof broken; id: string }[] = [
        { what: "brain", id: "t1" },
        { what: "decision", id: "t2" },
        { what: "tool", id: "t3" },
        { what: "sender", id: "t4" },
      ]

      for (const turn of turns) {
        // Only this dependency, so each turn is one failure.
        broken.brain = false
        broken.decision = false
        broken.tool = false
        broken.sender = false

        broken[turn.what] = true

        const result = await agent.receiveAndWait(
          hello({ channelMessageId: turn.id, text: `message ${turn.id}` }),
        )
        const state = await sweptState(agent, result.inboxId, result.turn?.outcome)

        await check(agent, await personOf(agent), () => {
          // The same bar, four times, whatever was broken.
          expectSwept(state)
          expect(state.outcome).toBe("replied")
        })
      }

      // Three of the four reached the channel. The fourth was the sender
      // itself, so it is written down and not delivered, which is the one
      // failure that cannot be answered through.
      const replies = await agent.store.outbox.list(
        { kind: "reply" },
        { orderBy: "seq", ascending: true },
      )
      expect(replies).toHaveLength(4)
      expect(replies.filter((out) => out.status === "sent")).toHaveLength(3)
      expect(replies[3]?.status).toBe("unknown")
    })
  })
})
