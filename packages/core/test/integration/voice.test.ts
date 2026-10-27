// LOOP-6, MEDIA-1 and MEDIA-3: a voice note, end to end through a turn.
//
// The adapters are proven against recorded responses elsewhere. What this
// file is for is the part that only a real turn can show: that the
// transcript becomes what the message says, that the audio is not stored
// and its reference is, that the language reaches the person's row, and
// that a voice note nobody could hear still gets an answer rather than
// costing the person their turn.
import { test, expect, describe, beforeAll, beforeEach } from "bun:test"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { migrate } from "../../src/migrate/index.ts"
import { replyKey, type Agent, type AgentOptions } from "../../src/runtime/index.ts"
import { TYPE_INSTEAD_REPLY } from "../../src/runtime/media.ts"
import { WANTS_HUMAN } from "../../src/runtime/handover.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { scriptedBrain, type ScriptedBrain } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import { TranscribeError, type Transcriber } from "../../src/providers/transcribers/types.ts"

const PROMPT = "You are the host at a restaurant."
/** Monday, 11:30 in Asia/Kolkata. */
const NOW = "2026-10-19T06:00:00Z"

const agents = trackAgents("voice.test.ts")

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
    ...over,
  })
}

/** A transcriber that hears one thing, and counts how often it was asked. */
function hears(text: string, extra: { language?: string; costUsd?: number } = {}) {
  const asked: { ref: string; mime: string }[] = []
  const transcriber: Transcriber = {
    id: "fake",
    async transcribe(media) {
      asked.push(media)
      return { text, ...extra }
    },
  }
  return { transcriber, asked }
}

/** A transcriber that cannot hear anything. */
const deaf: Transcriber = {
  id: "fake",
  async transcribe() {
    throw new TranscribeError("fake", "the audio could not be read", false)
  },
}

describeDatabase("a voice note", (sql) => {
  const clock = fixedClock(NOW)
  let sender: FakeSender

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
    clock.set(NOW)
  })

  function agentWith(
    transcriber: Transcriber | undefined,
    over: Record<string, unknown> = {},
  ): { agent: Agent; brain: ScriptedBrain } {
    const brain = scriptedBrain([{ reply: "We open at 11." }], { exhaustedReply: "Anything else?" })
    sender = fakeSender()
    const build: AgentOptions = {
      config: config(over),
      deps: {
        brains: [brain],
        decisionModel: scriptedDecisionModel([
          { [WANTS_HUMAN]: yesno(0), [GATE_QUESTION]: yesno(1) },
        ]),
        db: localSupabase(),
        sender,
        clock,
        ...(transcriber !== undefined ? { transcriber } : {}),
      },
      prompt: PROMPT,
      tools: [],
    }
    return { agent: agents.create(build), brain }
  }

  /** The last thing the brain was told the person said. */
  const lastSaid = (brain: ScriptedBrain): string | undefined => {
    const message = brain.calls[0]?.messages.at(-1)
    return message !== undefined && "text" in message ? message.text : undefined
  }

  /** An inbound voice note, with no text of its own. */
  const voice = (over: Record<string, unknown> = {}) => ({
    channel: "whatsapp",
    channelUserId: "9",
    channelMessageId: `m-${Math.random()}`,
    media: [{ kind: "audio" as const, ref: "https://m/note-1", mime: "audio/ogg; codecs=opus" }],
    ...over,
  })

  describe("MEDIA-1: the transcript is what the message says", () => {
    test("LOOP-6 and MEDIA-1: the brain is asked about the words, not a voice note", async () => {
      const { transcriber, asked } = hears("do you have a table for four")
      const { agent, brain } = agentWith(transcriber)

      await agent.receiveAndWait(voice())

      // The media ref was fetched by the adapter, which is given it here.
      expect(asked).toHaveLength(1)
      expect(asked[0]?.ref).toBe("https://m/note-1")

      expect(lastSaid(brain)).toBe("do you have a table for four")
      expect(sender.texts()).toEqual(["We open at 11."])
    })

    test("MEDIA-1: the row keeps the transcript and the reference, never the audio", async () => {
      const { transcriber } = hears("a table for four please")
      const { agent } = agentWith(transcriber)

      await agent.receiveAndWait(voice())

      const rows = await agent.store.messages.list({ direction: "inbound" }, { orderBy: "seq" })
      const row = rows[0]
      expect(row?.text).toBe("a table for four please")
      expect(row?.transcript).toBe("a table for four please")
      expect(row?.media_ref).toBe("https://m/note-1")
    })

    test("MEDIA-3: the language is stored on the person", async () => {
      const { transcriber } = hears("namaste, table hai kya", { language: "hi-IN" })
      const { agent } = agentWith(transcriber)

      await agent.receiveAndWait(voice())

      const who = (await agent.store.people.list({ role: "end_user" }))[0]
      expect(who?.language).toBe("hi-IN")
    })

    test("MEDIA-3: the brain is told to answer in that language", async () => {
      const { transcriber } = hears("namaste", { language: "hi-IN" })
      const { agent, brain } = agentWith(transcriber)

      await agent.receiveAndWait(voice())

      // The runtime block carries it, so the brain sees it on this turn
      // rather than only on the next one.
      expect(brain.calls[0]?.system).toContain("hi-IN")
    })

    test("LIMIT-3: what the transcription cost is on the turn and on the day", async () => {
      const { transcriber } = hears("hello there", { costUsd: 0.0002 })
      const { agent } = agentWith(transcriber)

      const result = await agent.receiveAndWait(voice())

      expect(result.turn?.costUsd).toBeCloseTo(0.0002, 10)
      const turn = await agent.store.turns.find({})
      expect(Number(turn?.cost_usd)).toBeCloseTo(0.0002, 10)
      const spent = await agent.limits.spent()
      expect(spent.usd).toBeCloseTo(0.0002, 10)
    })

    test("EVT-2: the transcription is in the trace", async () => {
      const { transcriber } = hears("hello", { language: "en", costUsd: 0.0001 })
      const { agent } = agentWith(transcriber)

      await agent.receiveAndWait(voice())

      const events = await agent.store.events.list({ name: "transcribed" }, { orderBy: "seq" })
      expect(events).toHaveLength(1)
      expect((events[0]?.props as { ok?: boolean }).ok).toBe(true)
    })
  })

  describe("MEDIA-1: when it cannot be heard, the person is asked to type", () => {
    test("MEDIA-1: with no transcriber, and with no brain call", async () => {
      // An agent that never expected audio. The person still gets a
      // sentence, and nothing is spent working out what to say.
      const { agent, brain } = agentWith(undefined)

      const result = await agent.receiveAndWait(voice())

      expect(sender.texts()).toEqual([TYPE_INSTEAD_REPLY])
      expect(brain.calls).toHaveLength(0)
      expect(result.turn?.outcome).toBe("no_transcript")
    })

    test("MEDIA-1: when the transcriber fails, and the trace says why", async () => {
      const { agent, brain } = agentWith(deaf)

      const result = await agent.receiveAndWait(voice())

      expect(sender.texts()).toEqual([TYPE_INSTEAD_REPLY])
      expect(brain.calls).toHaveLength(0)
      expect(result.turn?.outcome).toBe("no_transcript")

      const events = await agent.store.events.list({ name: "transcribed" }, { orderBy: "seq" })
      expect((events[0]?.props as { ok?: boolean }).ok).toBe(false)
    })

    test("MEDIA-1: the reference is still stored, so the audio can be found", async () => {
      const { agent } = agentWith(deaf)

      await agent.receiveAndWait(voice())

      const rows = await agent.store.messages.list({ direction: "inbound" }, { orderBy: "seq" })
      expect(rows[0]?.media_ref).toBe("https://m/note-1")
      expect(rows[0]?.transcript).toBeNull()
    })

    test("MEDIA-1: a voice note that failed does not silence the line typed with it", async () => {
      // The part that arrived is still a question, and ignoring it
      // because the other part failed would be the agent losing a
      // message it was handed.
      const { agent, brain } = agentWith(deaf)

      await agent.receiveAndWait(voice({ text: "and what time do you open?" }))

      expect(brain.calls).toHaveLength(1)
      expect(lastSaid(brain)).toBe("and what time do you open?")
      expect(sender.texts()).toEqual([TYPE_INSTEAD_REPLY, "We open at 11."])
    })

    test("LOOP-11: the same batch is told once, however often the turn runs", async () => {
      // Keyed by the messages it answers, like every other reply. The key
      // is where the guarantee lives, so the key is what is asserted.
      const { agent } = agentWith(deaf)

      const result = await agent.receiveAndWait(voice())

      const row = await agent.store.outbox.find({
        idempotency_key: `transcript:${replyKey([result.inboxId])}`,
      })
      expect(row).not.toBeNull()
      expect(row?.status).toBe("sent")
    })
  })

  describe("LOOP-5 step 1: a blocked person costs nothing", () => {
    test("ROLE-4 and MEDIA-1: their voice note is not transcribed, and not answered", async () => {
      // A transcription is a paid provider call exactly like a brain call,
      // and LOOP-5 step 1 says a blocked person costs neither.
      const { transcriber, asked } = hears("let me in", { costUsd: 0.5 })
      const { agent, brain } = agentWith(transcriber)

      const who = await agent.store.people.insert({
        channel: "whatsapp",
        channel_user_id: "9",
        blocked: true,
      })
      expect(who.blocked).toBe(true)

      const result = await agent.receiveAndWait(voice())

      expect(asked).toEqual([])
      expect(brain.calls).toHaveLength(0)
      expect(sender.sent).toEqual([])
      expect(result.turn?.outcome).toBe("blocked")
      expect((await agent.limits.spent()).usd).toBe(0)
    })

    test("ROLE-4: their message is still stored, with the reference", async () => {
      const { transcriber } = hears("let me in")
      const { agent } = agentWith(transcriber)

      await agent.store.people.insert({
        channel: "whatsapp",
        channel_user_id: "9",
        blocked: true,
      })
      await agent.receiveAndWait(voice())

      const rows = await agent.store.messages.list({ direction: "inbound" }, { orderBy: "seq" })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.media_ref).toBe("https://m/note-1")
      expect(rows[0]?.transcript).toBeNull()
    })
  })
})
