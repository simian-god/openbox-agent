import { test, expect, describe } from "bun:test"
import {
  buildRuntimeBlock,
  buildSystem,
  buildMessages,
  withoutImages,
  partsInZone,
} from "../../src/runtime/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import type { MessageRow, PersonRow } from "../../src/store/index.ts"

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: {
      mon: [
        ["11:00", "15:00"],
        ["19:00", "23:00"],
      ],
      tue: [["11:00", "23:00"]],
      wed: [["11:00", "23:00"]],
      thu: [["11:00", "23:00"]],
      fri: [["11:00", "23:00"]],
      sat: [["11:00", "23:00"]],
    },
    brain: { id: "openrouter", model: "m" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages.",
    retentionDays: 365,
    ...over,
  })
}

const person = (over: Partial<PersonRow> = {}): PersonRow => ({
  id: "p1",
  agent_id: "restaurant",
  channel: "whatsapp",
  channel_user_id: "42",
  role: "end_user",
  display_name: "Asha",
  language: "en",
  blocked: false,
  opted_out: false,
  notice_shown_at: null,
  created_at: "2026-10-16T00:00:00Z",
  updated_at: "2026-10-16T00:00:00Z",
  ...over,
})

const message = (over: Partial<MessageRow>): MessageRow => ({
  id: "m1",
  seq: 1,
  agent_id: "restaurant",
  person_id: "p1",
  turn_id: null,
  direction: "inbound",
  author: "person",
  text: "hello",
  transcript: null,
  media_ref: null,
  channel: "whatsapp",
  created_at: "2026-10-16T00:00:00Z",
  ...over,
})

describe("LOOP-7: the runtime block", () => {
  // 2026-10-19 is a Monday. 18:30 UTC is 00:00 next day in Kolkata, which
  // is the case a server-timezone bug would get wrong.
  const monday = new Date("2026-10-19T06:00:00Z")

  test("LOOP-7: it carries the date, time, weekday and timezone", () => {
    const block = buildRuntimeBlock({ config: config(), person: person(), now: monday })

    expect(block).toContain("2026-10-19")
    expect(block).toContain("Monday")
    expect(block).toContain("11:30")
    expect(block).toContain("Asia/Kolkata")
  })

  test("LOOP-7: the date is the agent's, not the server's", () => {
    // 20:00 UTC on the 19th is already the 20th in Kolkata.
    const block = buildRuntimeBlock({
      config: config(),
      person: person(),
      now: new Date("2026-10-19T20:00:00Z"),
    })

    expect(block).toContain("2026-10-20")
    expect(block).toContain("Tuesday")
  })

  test("LOOP-7: it carries the person's role, channel, name and language", () => {
    const block = buildRuntimeBlock({ config: config(), person: person(), now: monday })

    expect(block).toContain("Role: end_user")
    expect(block).toContain("Channel: whatsapp")
    expect(block).toContain("Asha")
    expect(block).toContain("en")
  })

  test("LOOP-7: an operator is described as an operator", () => {
    const block = buildRuntimeBlock({
      config: config(),
      person: person({ role: "operator" }),
      now: monday,
    })
    expect(block).toContain("Role: operator")
  })

  test("LOOP-7: a person with no name or language has no empty lines about them", () => {
    const block = buildRuntimeBlock({
      config: config(),
      person: person({ display_name: null, language: null }),
      now: monday,
    })

    expect(block).not.toContain("Name:")
    expect(block).not.toContain("Language:")
  })

  test("LOOP-7: today's and tomorrow's opening hours are both given", () => {
    const block = buildRuntimeBlock({ config: config(), person: person(), now: monday })

    expect(block).toContain("Today: 11:00 to 15:00, 19:00 to 23:00")
    expect(block).toContain("Tomorrow: 11:00 to 23:00")
  })

  test("LOOP-7: a day with no hours reads as closed", () => {
    // Sunday the 18th has no entry in this config.
    const block = buildRuntimeBlock({
      config: config(),
      person: person(),
      now: new Date("2026-10-18T06:00:00Z"),
    })
    expect(block).toContain("Today: closed")
  })

  test("LOOP-7: an exception beats the usual hours for that day", () => {
    const block = buildRuntimeBlock({
      config: config({
        hours: {
          mon: [["11:00", "23:00"]],
          exceptions: [{ date: "2026-10-19", closed: true }],
        },
      }),
      person: person(),
      now: monday,
    })
    expect(block).toContain("Today: closed")
  })

  test("LOOP-7: an exception can give different hours rather than closing", () => {
    const block = buildRuntimeBlock({
      config: config({
        hours: {
          mon: [["11:00", "23:00"]],
          exceptions: [{ date: "2026-10-19", ranges: [["18:00", "20:00"]] }],
        },
      }),
      person: person(),
      now: monday,
    })
    expect(block).toContain("Today: 18:00 to 20:00")
  })

  test("LOOP-7: the system prompt comes first, then the runtime block", () => {
    const system = buildSystem("You are the host at Tipu's.", "# Right now\nDate: 2026-10-19")

    expect(system.indexOf("You are the host")).toBeLessThan(system.indexOf("# Right now"))
    expect(system).toContain("Date: 2026-10-19")
  })

  test("LOOP-7: reading the clock in a zone does not shift the instant", () => {
    const at = new Date("2026-10-19T06:00:00Z")
    expect(partsInZone(at, "UTC")).toEqual({
      weekday: "Monday",
      date: "2026-10-19",
      time: "06:00",
    })
  })
})

describe("LOOP-7: the messages", () => {
  test("LOOP-7: history comes first, then the current batch", () => {
    const messages = buildMessages(
      [message({ text: "older" }), message({ text: "newer", author: "agent" })],
      [{ text: "what I just said" }],
    )

    expect(messages).toEqual([
      { role: "person", text: "older" },
      { role: "agent", text: "newer" },
      { role: "person", text: "what I just said" },
    ])
  })

  test("LOOP-7: an operator's words and a notice keep their own author", () => {
    const messages = buildMessages(
      [
        message({ author: "operator", text: "We are full." }),
        message({ author: "notice", text: "We store your messages." }),
      ],
      [],
    )

    expect(messages[0]?.role).toBe("operator")
    expect(messages[1]?.role).toBe("notice")
  })

  test("LOOP-7: a transcribed voice note is read as what the person said", () => {
    const messages = buildMessages([message({ text: null, transcript: "book me a table" })], [])
    expect(messages[0]).toEqual({ role: "person", text: "book me a table" })
  })

  test("LOOP-7: a whole batch is passed, in arrival order", () => {
    const messages = buildMessages([], [{ text: "first" }, { text: "second" }, { text: "third" }])
    expect(messages.map((m) => ("text" in m ? m.text : ""))).toEqual(["first", "second", "third"])
  })
})

describe("MEDIA-2: pictures on a message", () => {
  test("MEDIA-2: images ride along with the text of the batch", () => {
    const messages = buildMessages(
      [],
      [{ text: "is this still on?", images: [{ ref: "https://m/pic", mime: "image/jpeg" }] }],
    )

    const said = messages[0]
    expect(said?.role).toBe("person")
    expect(said !== undefined && "images" in said ? said.images : undefined).toEqual([
      { ref: "https://m/pic", mime: "image/jpeg" },
    ])
  })

  test("MEDIA-2: a message with no images has no images field at all", () => {
    // Not an empty array. The field being absent is what lets a brain
    // adapter send the plain string shape, which is the common case.
    const messages = buildMessages([], [{ text: "just typing" }])

    expect(messages[0] !== undefined && "images" in messages[0]).toBe(false)
  })

  test("MEDIA-2: an empty image list is treated as none", () => {
    const messages = buildMessages([], [{ text: "hello", images: [] }])

    expect(messages[0] !== undefined && "images" in messages[0]).toBe(false)
  })

  test("MEDIA-2: withoutImages leaves the words and takes the pictures", () => {
    const messages = buildMessages(
      [],
      [{ text: "what is this", images: [{ ref: "r", mime: "image/png" }] }],
    )

    const stripped = withoutImages(messages)
    expect(stripped[0] !== undefined && "images" in stripped[0]).toBe(false)
    expect(stripped[0] !== undefined && "text" in stripped[0] ? stripped[0].text : "").toBe(
      "what is this",
    )
  })

  test("MEDIA-2: withoutImages leaves every other message untouched", () => {
    const messages = buildMessages([], [{ text: "plain" }])

    expect(withoutImages(messages)).toEqual(messages)
  })

  test("LOOP-7: history never carries pictures, however old the photo was", () => {
    // Bounded on purpose. Re-sending every picture a person ever sent on
    // every turn would grow the request with the conversation, and the
    // caption is already in the history as text.
    const messages = buildMessages([message({ text: "a photo I sent", author: "person" })], [])

    expect(messages[0] !== undefined && "images" in messages[0]).toBe(false)
  })
})
