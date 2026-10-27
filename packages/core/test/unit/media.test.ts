// LOOP-6 and MEDIA-1: what a batch of messages turns into once anything
// audible in it has been heard.
//
// Tested on its own rather than only through a turn, because the rules
// here decide whether a person gets an answer at all: a failed
// transcription must not become an empty message, and it must not become
// an exception that loses the turn.
import { test, expect, describe } from "bun:test"
import { audioIn, listen, TYPE_INSTEAD_REPLY } from "../../src/runtime/media.ts"
import { TranscribeError, type Transcriber } from "../../src/providers/transcribers/types.ts"

const VOICE = [{ kind: "audio", ref: "https://m/1", mime: "audio/ogg" }]

/** A transcriber that answers in order, and remembers what it was asked. */
function hears(answers: { text: string; language?: string; costUsd?: number }[]): Transcriber {
  let at = 0
  return {
    id: "fake",
    async transcribe() {
      const answer = answers[Math.min(at++, answers.length - 1)]
      if (answer === undefined) throw new TranscribeError("fake", "nothing scripted", false)
      return answer
    },
  }
}

/** A transcriber that always fails. */
const deaf: Transcriber = {
  id: "fake",
  async transcribe() {
    throw new TranscribeError("fake", "the audio could not be read", false)
  },
}

/** Collects the trace, so a test can assert what was recorded. */
function recorder() {
  const events: Record<string, unknown>[] = []
  return {
    events,
    record: (_name: "transcribed", props: Record<string, unknown>) => {
      events.push(props)
    },
  }
}

describe("MEDIA-1: reading the media column", () => {
  test("MEDIA-1: audio items are found, and a caption comes with them", () => {
    const found = audioIn([
      { kind: "audio", ref: "r1", mime: "audio/ogg", caption: "about tonight" },
      { kind: "image", ref: "r2", mime: "image/png" },
    ])

    expect(found).toHaveLength(1)
    expect(found[0]?.ref).toBe("r1")
    expect(found[0]?.caption).toBe("about tonight")
  })

  test("a half written row is dropped rather than trusted", () => {
    // The column is jsonb, so it holds whatever was written rather than
    // whatever the type says, and a request built out of half a row is a
    // request for nothing.
    expect(audioIn(null)).toEqual([])
    expect(audioIn("not an array")).toEqual([])
    expect(audioIn([null, 7, "x"])).toEqual([])
    expect(audioIn([{ kind: "audio", mime: "audio/ogg" }])).toEqual([])
    expect(audioIn([{ kind: "audio", ref: "", mime: "audio/ogg" }])).toEqual([])
    expect(audioIn([{ kind: "audio", ref: "r", mime: "" }])).toEqual([])
  })
})

describe("LOOP-6: listening to a batch", () => {
  test("a batch with no audio is left alone and costs nothing", async () => {
    const { record, events } = recorder()
    const result = await listen({
      batch: [{ id: "a", text: "hello", media: null }],
      transcriber: hears([{ text: "never asked" }]),
      record,
    })

    expect(result.heard.size).toBe(0)
    expect(result.failed).toBe(false)
    expect(result.costUsd).toBe(0)
    expect(events).toEqual([])
  })

  test("MEDIA-1: the transcript becomes the text of the message", async () => {
    const { record } = recorder()
    const result = await listen({
      batch: [{ id: "a", text: null, media: VOICE }],
      transcriber: hears([{ text: "a table for four please" }]),
      record,
    })

    expect(result.heard.get("a")?.text).toBe("a table for four please")
    expect(result.heard.get("a")?.transcript).toBe("a table for four please")
    expect(result.failed).toBe(false)
  })

  test("MEDIA-3: the language it was heard in comes back", async () => {
    const { record } = recorder()
    const result = await listen({
      batch: [{ id: "a", text: null, media: VOICE }],
      transcriber: hears([{ text: "namaste", language: "hi-IN" }]),
      record,
    })

    expect(result.language).toBe("hi-IN")
  })

  test("MEDIA-3: the first language wins, so one answer is not two", async () => {
    const { record } = recorder()
    const result = await listen({
      batch: [
        { id: "a", text: null, media: VOICE },
        { id: "b", text: null, media: VOICE },
      ],
      transcriber: hears([
        { text: "namaste", language: "hi-IN" },
        { text: "hello", language: "en" },
      ]),
      record,
    })

    expect(result.language).toBe("hi-IN")
  })

  test("LIMIT-3: what every transcription cost is added up", async () => {
    const { record } = recorder()
    const result = await listen({
      batch: [
        { id: "a", text: null, media: VOICE },
        { id: "b", text: null, media: VOICE },
      ],
      transcriber: hears([
        { text: "one", costUsd: 0.0002 },
        { text: "two", costUsd: 0.0003 },
      ]),
      record,
    })

    expect(result.costUsd).toBeCloseTo(0.0005, 10)
  })
})

describe("MEDIA-1: when a voice note cannot be heard", () => {
  test("a typed line and a caption come along with the transcript", async () => {
    // Somebody who records a voice note and types a word with it meant
    // both, so the brain gets both.
    const { record } = recorder()
    const result = await listen({
      batch: [
        {
          id: "a",
          text: "also",
          media: [{ kind: "audio", ref: "r", mime: "audio/ogg", caption: "for tonight" }],
        },
      ],
      transcriber: hears([{ text: "a table for four" }]),
      record,
    })

    expect(result.heard.get("a")?.text.split("\n")).toEqual([
      "also",
      "for tonight",
      "a table for four",
    ])
  })

  test("MEDIA-1: with no transcriber it fails, and the trace says which", async () => {
    // "The agent has no transcriber" and "the transcriber broke" look the
    // same to the person and must not look the same in the trace.
    const { record, events } = recorder()
    const result = await listen({
      batch: [{ id: "a", text: null, media: VOICE }],
      record,
    })

    expect(result.failed).toBe(true)
    expect(result.heard.get("a")?.transcript).toBeNull()
    expect(events).toHaveLength(1)
    expect(events[0]?.["ok"]).toBe(false)
    expect(String(events[0]?.["why"])).toContain("no transcriber")
  })

  test("MEDIA-1: a transcriber that throws never loses the turn", async () => {
    const { record, events } = recorder()
    const result = await listen({
      batch: [{ id: "a", text: null, media: VOICE }],
      transcriber: deaf,
      record,
    })

    expect(result.failed).toBe(true)
    expect(result.heard.get("a")?.text).toBe("")
    expect(events[0]?.["ok"]).toBe(false)
    expect(String(events[0]?.["why"])).toContain("could not be read")
  })

  test("MEDIA-1: one voice note failing does not silence the other", async () => {
    let first = true
    const flaky: Transcriber = {
      id: "fake",
      async transcribe() {
        if (first) {
          first = false
          throw new TranscribeError("fake", "that one broke", true)
        }
        return { text: "but this one was fine" }
      },
    }

    const { record } = recorder()
    const result = await listen({
      batch: [
        { id: "a", text: null, media: VOICE },
        { id: "b", text: null, media: VOICE },
      ],
      transcriber: flaky,
      record,
    })

    expect(result.failed).toBe(true)
    expect(result.heard.get("a")?.text).toBe("")
    expect(result.heard.get("b")?.text).toBe("but this one was fine")
  })

  test("EVT-2: a transcription that worked is recorded with what it cost", async () => {
    const { record, events } = recorder()
    await listen({
      batch: [{ id: "a", text: null, media: VOICE }],
      transcriber: hears([{ text: "hello there", language: "en", costUsd: 0.0002 }]),
      record,
    })

    expect(events).toHaveLength(1)
    expect(events[0]?.["ok"]).toBe(true)
    expect(events[0]?.["provider"]).toBe("fake")
    expect(events[0]?.["language"]).toBe("en")
    expect(events[0]?.["costUsd"]).toBe(0.0002)
    expect(events[0]?.["characters"]).toBe("hello there".length)
  })

  test("the reply MEDIA-1 asks for tells the person what to do instead", () => {
    // Not the brain's words. Somebody whose voice note failed needs the
    // way forward in the same sentence.
    expect(TYPE_INSTEAD_REPLY.toLowerCase()).toContain("type")
  })
})
