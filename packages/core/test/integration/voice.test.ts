// LOOP-6, MEDIA-1 and MEDIA-3: a voice note, end to end through a turn.
//
// The adapters are proven against recorded responses elsewhere. What this
// file is for is the part that only a real turn can show: that the
// transcript becomes what the message says, that the audio is not stored
// and its reference is, that the language reaches the person's row, and
// that a voice note nobody could hear still gets an answer rather than
// costing the person their turn.
import { test, expect, describe, beforeEach } from "bun:test"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { replyKey, type Agent, type AgentOptions } from "../../src/runtime/index.ts"
import { CANNOT_READ_IMAGES_REPLY, TYPE_INSTEAD_REPLY } from "../../src/runtime/media.ts"
import { WANTS_HUMAN } from "../../src/runtime/handover.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { defineTool, type Tool } from "../../src/tools/index.ts"
import { z } from "zod"
import {
  scriptedBrain,
  type ScriptedBrain,
  type ScriptedStep,
} from "../../src/testing/scripted-brain.ts"
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

  beforeEach(async () => {
    await resetDatabase(sql())
    clock.set(NOW)
  })

  function agentWith(
    transcriber: Transcriber | undefined,
    over: Record<string, unknown> = {},
    how: {
      supportsImages?: boolean
      files?: boolean
      tools?: Tool[]
      script?: ScriptedStep[]
      /** CONF-3: signs the confirm buttons. Never in config (CFG-2). */
      secret?: string
    } = {},
  ): { agent: Agent; brain: ScriptedBrain } {
    const brain = scriptedBrain(how.script ?? [{ reply: "We open at 11." }], {
      exhaustedReply: "Anything else?",
      ...(how.supportsImages !== undefined ? { supportsImages: how.supportsImages } : {}),
    })
    sender = fakeSender(how.files === undefined ? {} : { capabilities: { files: how.files } })
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
      tools: how.tools ?? [],
      ...(how.secret !== undefined ? { secret: how.secret } : {}),
    }
    return { agent: agents.create(build), brain }
  }

  /** The last thing the brain was told the person said. */
  const lastSaid = (brain: ScriptedBrain): string | undefined => {
    const message = brain.calls[0]?.messages.at(-1)
    return message !== undefined && "text" in message ? message.text : undefined
  }

  /** An inbound photo, with an optional caption. */
  const photo = (caption?: string, over: Record<string, unknown> = {}) => ({
    channel: "whatsapp",
    channelUserId: "9",
    channelMessageId: `m-${Math.random()}`,
    media: [
      {
        kind: "image" as const,
        ref: "https://m/pic-1",
        mime: "image/jpeg",
        ...(caption !== undefined ? { caption } : {}),
      },
    ],
    ...over,
  })

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

  describe("MEDIA-2: a photo", () => {
    test("MEDIA-2: a brain that can read pictures is given them", async () => {
      const { agent, brain } = agentWith(undefined, {}, { supportsImages: true })

      await agent.receiveAndWait(photo("is this still on?"))

      const said = brain.calls[0]?.messages.at(-1)
      expect(said !== undefined && "images" in said ? said.images : undefined).toEqual([
        { ref: "https://m/pic-1", mime: "image/jpeg" },
      ])
      // MEDIA-2: the caption is the text, so the brain has both.
      expect(lastSaid(brain)).toBe("is this still on?")
      expect(sender.texts()).toEqual(["We open at 11."])
    })

    test("MEDIA-2: a brain that cannot is told nothing about the picture", async () => {
      const { agent, brain } = agentWith(undefined, {}, { supportsImages: false })

      await agent.receiveAndWait(photo("is this still on?"))

      const said = brain.calls[0]?.messages.at(-1)
      expect(said !== undefined && "images" in said).toBe(false)
    })

    test("MEDIA-2: and the person is told so, with the caption still answered", async () => {
      // Both lines are true, so both are sent: the agent cannot see the
      // photo, and the question they typed with it still has an answer.
      const { agent, brain } = agentWith(undefined, {}, { supportsImages: false })

      await agent.receiveAndWait(photo("is this still on?"))

      expect(sender.texts()).toEqual([CANNOT_READ_IMAGES_REPLY, "We open at 11."])
      expect(brain.calls).toHaveLength(1)
    })

    test("MEDIA-2: a photo with no caption and no reader costs no brain call", async () => {
      const { agent, brain } = agentWith(undefined, {}, { supportsImages: false })

      const result = await agent.receiveAndWait(photo())

      expect(sender.texts()).toEqual([CANNOT_READ_IMAGES_REPLY])
      expect(brain.calls).toHaveLength(0)
      expect(result.turn?.outcome).toBe("cannot_read_images")
    })

    test("LOOP-11: the same batch is told once, whatever the sweep does", async () => {
      const { agent } = agentWith(undefined, {}, { supportsImages: false })

      const result = await agent.receiveAndWait(photo())

      const row = await agent.store.outbox.find({
        idempotency_key: `images:${replyKey([result.inboxId])}`,
      })
      expect(row?.status).toBe("sent")
    })

    test("MEDIA-2: a reader is not told the person cannot be helped", async () => {
      const { agent } = agentWith(undefined, {}, { supportsImages: true })

      await agent.receiveAndWait(photo("this one"))

      expect(sender.texts()).not.toContain(CANNOT_READ_IMAGES_REPLY)
    })

    test("MEDIA-2: the decision model is only ever shown text", async () => {
      // MEDIA-2's last clause, in its own test. Routing reasons over the
      // batch (ROUTE-1), and what it must reason over is the caption, not
      // a picture: the decision model takes text and a ref in a field it
      // does not understand would be noise at best.
      const asked: unknown[] = []
      const recording = {
        id: "recording",
        async ask(state: unknown, questions: Record<string, unknown>) {
          asked.push(state)
          const answers: Record<string, unknown> = {}
          for (const name of Object.keys(questions)) {
            answers[name] = { type: "yesno", p: 1, confidence: 1 }
          }
          return { answers, usage: { inputTokens: 1, costUsd: 0 } }
        },
      }

      sender = fakeSender()
      const brain = scriptedBrain([{ reply: "Still on the menu." }], { supportsImages: true })
      const agent = agents.create({
        config: config({ routingMinTools: 0 }),
        deps: {
          brains: [brain],
          decisionModel: recording as never,
          db: localSupabase(),
          sender,
          clock,
        },
        prompt: PROMPT,
        tools: [],
      })

      await agent.receiveAndWait(photo("is this still on?"))

      const whole = JSON.stringify(asked)
      expect(whole).toContain("is this still on?")
      // The ref never reaches it, under any key.
      expect(whole).not.toContain("https://m/pic-1")
    })

    test("MEDIA-2: the reference is stored, and the picture is not", async () => {
      const { agent } = agentWith(undefined, {}, { supportsImages: true })

      await agent.receiveAndWait(photo("this one"))

      const rows = await agent.store.messages.list({ direction: "inbound" }, { orderBy: "seq" })
      expect(rows[0]?.media_ref).toBe("https://m/pic-1")
      expect(rows[0]?.text).toBe("this one")
    })
  })

  describe("MEDIA-4: a tool sending a file", () => {
    const menu = (): Tool =>
      defineTool({
        name: "send_menu",
        description: "Sends the menu as a PDF.",
        input: z.object({}),
        risk: "read",
        roles: ["end_user"],
        conditions: { callWhen: ["they ask for the menu"], dontCallWhen: ["never"] },
        examples: { should: ["send me the menu"], shouldNot: ["hello"] },
        handler: async (_args, ctx) => {
          await ctx.sendFile(
            { url: "https://files/menu.pdf", name: "menu.pdf", mime: "application/pdf" },
            { caption: "Tonight's menu" },
          )
          return { sent: true }
        },
      })

    test("MEDIA-4: the file goes out through the outbox, with its caption", async () => {
      const { agent } = agentWith(
        undefined,
        {},
        {
          files: true,
          tools: [menu()],
          script: [{ tool: "send_menu" }, { reply: "That is the menu." }],
        },
      )
      const built = agent.tools.all().find((tool) => tool.name === "send_menu")
      expect(built).toBeDefined()

      await agent.receiveAndWait({
        channel: "whatsapp",
        channelUserId: "9",
        channelMessageId: "m-menu",
        text: "send me the menu",
      })

      const rows = await agent.store.outbox.list({}, { orderBy: "seq" })
      const file = rows.find((row) => (row.payload as { file?: unknown }).file !== undefined)
      expect(file).toBeDefined()
      expect((file?.payload as { file: { name: string } }).file.name).toBe("menu.pdf")
      expect((file?.payload as { text?: string }).text).toBe("Tonight's menu")
      expect(file?.status).toBe("sent")
    })

    test("MEDIA-2: in a chain, only the brain that can read them gets them", async () => {
      // The per-brain half of MEDIA-2, which neither of the tests above
      // reaches: with one brain the two guards cover each other, so a
      // probe could remove either and nothing failed. Here the primary
      // cannot see pictures and the fallback can, so the pictures are
      // attached to the batch and still must not reach the primary.
      const blind = scriptedBrain([{ throws: "the primary is down" }], {
        id: "blind",
        supportsImages: false,
      })
      const seeing = scriptedBrain([{ reply: "That is still on the menu." }], {
        id: "seeing",
        supportsImages: true,
      })
      sender = fakeSender()
      const agent = agents.create({
        config: config({
          brain: {
            id: "openrouter",
            model: "blind/one",
            fallbacks: [{ id: "openrouter", model: "seeing/one" }],
          },
        }),
        deps: {
          brains: [blind, seeing],
          decisionModel: scriptedDecisionModel([
            { [WANTS_HUMAN]: yesno(0), [GATE_QUESTION]: yesno(1) },
          ]),
          db: localSupabase(),
          sender,
          clock,
        },
        prompt: PROMPT,
        tools: [],
      })

      await agent.receiveAndWait(photo("is this still on?"))

      const toBlind = blind.calls[0]?.messages.at(-1)
      const toSeeing = seeing.calls[0]?.messages.at(-1)
      expect(toBlind !== undefined && "images" in toBlind).toBe(false)
      expect(toSeeing !== undefined && "images" in toSeeing ? toSeeing.images : undefined).toEqual([
        { ref: "https://m/pic-1", mime: "image/jpeg" },
      ])
      expect(sender.texts()).toEqual(["That is still on the menu."])
    })

    test("MEDIA-4: two files in one turn are two messages, not one", async () => {
      // The counter in the key. With one file a single key works either
      // way, which is how a probe slipped past the first version of this.
      const two: Tool = defineTool({
        name: "send_both",
        description: "Sends the menu and the wine list.",
        input: z.object({}),
        risk: "read",
        roles: ["end_user"],
        conditions: { callWhen: ["they ask for both"], dontCallWhen: ["never"] },
        examples: { should: ["menu and wine list"], shouldNot: ["hello"] },
        handler: async (_args, ctx) => {
          await ctx.sendFile({
            url: "https://files/menu.pdf",
            name: "menu.pdf",
            mime: "application/pdf",
          })
          await ctx.sendFile({
            url: "https://files/wine.pdf",
            name: "wine.pdf",
            mime: "application/pdf",
          })
          return { sent: 2 }
        },
      })

      const { agent } = agentWith(
        undefined,
        {},
        { files: true, tools: [two], script: [{ tool: "send_both" }, { reply: "Both sent." }] },
      )

      await agent.receiveAndWait({
        channel: "whatsapp",
        channelUserId: "9",
        channelMessageId: "m-both",
        text: "menu and wine list please",
      })

      const rows = await agent.store.outbox.list({}, { orderBy: "seq" })
      const files = rows.filter((row) => (row.payload as { file?: unknown }).file !== undefined)
      expect(files.map((row) => (row.payload as { file: { name: string } }).file.name)).toEqual([
        "menu.pdf",
        "wine.pdf",
      ])
      expect(new Set(files.map((row) => row.idempotency_key)).size).toBe(2)
    })

    test("MEDIA-4 and CONF-4: a confirmed tool can send its file too", async () => {
      // The bug a probe found. The confirmed path built its own tool
      // context and had been given no `sendFile`, so a receipt sent after
      // the person agreed would have thrown. `tool-context.ts` exists to
      // stop exactly that asymmetry, and nothing was testing it.
      const receipt: Tool = defineTool({
        name: "charge_card",
        description: "Charges the card and sends a receipt.",
        input: z.object({}),
        risk: "irreversible",
        roles: ["end_user"],
        confirmSummary: () => "Charge the card",
        conditions: { callWhen: ["they ask to pay"], dontCallWhen: ["never"] },
        examples: { should: ["pay now"], shouldNot: ["hello"] },
        handler: async (_args, ctx) => {
          await ctx.sendFile(
            { url: "https://files/receipt.pdf", name: "receipt.pdf", mime: "application/pdf" },
            { caption: "Your receipt" },
          )
          return { charged: true }
        },
      })

      const { agent } = agentWith(
        undefined,
        {},
        {
          secret: "a-long-test-secret",
          files: true,
          tools: [receipt],
          script: [{ tool: "charge_card" }, { reply: "Done." }, { reply: "Anything else?" }],
        },
      )

      await agent.receiveAndWait({
        channel: "whatsapp",
        channelUserId: "9",
        channelMessageId: "m-pay",
        text: "pay now please",
      })

      // CONF-1: nothing ran yet, and no file went out either.
      const pending = await agent.store.pendingActions.list({}, { orderBy: "seq" })
      expect(pending[0]?.status).toBe("pending")
      let rows = await agent.store.outbox.list({}, { orderBy: "seq" })
      expect(rows.some((row) => (row.payload as { file?: unknown }).file !== undefined)).toBe(false)

      // The person confirms with the code they were shown.
      await agent.receiveAndWait({
        channel: "whatsapp",
        channelUserId: "9",
        channelMessageId: "m-code",
        text: pending[0]?.code ?? "0000",
      })

      const after = await agent.store.pendingActions.list({}, { orderBy: "seq" })
      expect(after[0]?.status).toBe("executed")

      rows = await agent.store.outbox.list({}, { orderBy: "seq" })
      const file = rows.find((row) => (row.payload as { file?: unknown }).file !== undefined)
      expect(file).toBeDefined()
      expect((file?.payload as { file: { name: string } }).file.name).toBe("receipt.pdf")
      // Keyed by the action, not by a batch, so the same confirmed call
      // retried cannot send it twice.
      expect(file?.idempotency_key).toBe(`file:action:${after[0]?.id}:1`)
    })

    test("MEDIA-4: it is refused when the channel cannot carry files", async () => {
      // Refused here rather than at the vendor, so the brain reads the
      // error and can answer in words instead.
      const { agent } = agentWith(
        undefined,
        {},
        {
          files: false,
          tools: [menu()],
          script: [{ tool: "send_menu" }, { reply: "I cannot send it, but here it is in words." }],
        },
      )

      await agent.receiveAndWait({
        channel: "whatsapp",
        channelUserId: "9",
        channelMessageId: "m-menu-2",
        text: "send me the menu",
      })

      const rows = await agent.store.outbox.list({}, { orderBy: "seq" })
      expect(rows.every((row) => (row.payload as { file?: unknown }).file === undefined)).toBe(true)

      const runs = await agent.store.toolRuns.list({ tool: "send_menu" }, { orderBy: "seq" })
      expect(runs[0]?.status).toBe("error")
      expect(String(runs[0]?.error)).toContain("cannot send files")
    })
  })
})
