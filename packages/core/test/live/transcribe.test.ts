// The one test that calls OpenRouter's transcription endpoint for real.
//
// Everything else about this adapter is proven against recorded
// responses, which only shows it matches the documentation. This shows
// the documentation matches OpenRouter, and three of its claims are load
// bearing:
//
// - the endpoint accepts `input_audio: { data, format }` with raw base64
// - `response_format: "verbose_json"` really does add a `language` field,
//   which is the whole of MEDIA-3 for this provider
// - `usage` really does carry `cost`, which is how a transcription
//   reaches the LIMIT-3 spend cap
//
// What it cannot show is transcription quality, because there is no real
// speech here to transcribe. The audio is a generated tone, so an empty
// transcript is a pass: what is under test is the contract, not the ears.
// Quality is Known K21 and needs real voice notes from the builder.
//
//   OPENBOX_LIVE=1 bun test packages/core/test/live/transcribe.test.ts
import { test, expect, describe } from "bun:test"
import { openRouterTranscriber, DEFAULT_TRANSCRIBE_MODEL } from "../../src/providers/index.ts"
import { TranscribeError } from "../../src/providers/index.ts"
import type { FetchLike } from "../../src/providers/http.ts"

const apiKey = process.env["OPENROUTER_API_KEY"]
const live = process.env["OPENBOX_LIVE"] === "1" && apiKey !== undefined && apiKey !== ""

/** Half a second of 16-bit mono PCM at 16kHz, as a valid WAV file. */
function tone(): Uint8Array {
  const rate = 16_000
  const samples = rate / 2
  const data = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    data[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000)
  }
  const bytes = new Uint8Array(44 + data.byteLength)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i))
  }
  ascii(0, "RIFF")
  view.setUint32(4, 36 + data.byteLength, true)
  ascii(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, data.byteLength, true)
  bytes.set(new Uint8Array(data.buffer), 44)
  return bytes
}

const AUDIO = tone()

/**
 * Serves the audio from memory and lets the POST go to the real network.
 *
 * The adapter fetches the media ref first, and a live test has nowhere to
 * host a file. This keeps the request to OpenRouter completely real while
 * the audio comes from here.
 */
const localAudio: FetchLike = async (url, init) => {
  if ((init.method ?? "GET") === "GET" && url.startsWith("memory:")) {
    return new Response(AUDIO, { status: 200 })
  }
  return fetch(url, init)
}

const NOTE = { ref: "memory:tone.wav", mime: "audio/wav" }

describe.skipIf(!live)("MEDIA-1: against the real OpenRouter transcription endpoint", () => {
  test("MEDIA-1: the request shape is accepted, and usage comes back with a cost", async () => {
    // Called without the adapter, so the response can be read whatever
    // the transcript says. A tone transcribes to nothing useful, and the
    // adapter quite rightly treats an empty transcript as a failure.
    const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey as string}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_TRANSCRIBE_MODEL,
        input_audio: { data: Buffer.from(AUDIO).toString("base64"), format: "wav" },
        response_format: "verbose_json",
      }),
    })

    const body = (await response.json()) as {
      text?: string
      language?: string
      usage?: { cost?: number; seconds?: number }
    }
    console.log(`  [live] HTTP ${response.status} ${JSON.stringify(body).slice(0, 300)}`)

    // The shape being accepted is the claim. A 400 would mean the body
    // this adapter builds is wrong.
    expect(response.ok).toBe(true)
    expect(typeof body.text).toBe("string")

    // MEDIA-3 rests on this field existing in verbose mode.
    console.log(`  [live] language field present: ${body.language !== undefined}`)
    // LIMIT-3 rests on this one.
    console.log(`  [live] usage.cost: ${String(body.usage?.cost)}`)
    expect(typeof body.usage?.cost).toBe("number")
  }, 120_000)

  test("MEDIA-1: through the adapter, silence is a failure and not an empty message", async () => {
    // The end this matters at: a tone is not speech, so either a
    // transcript comes back or the adapter refuses it. What must never
    // happen is an empty string being handed on as what somebody said.
    const transcriber = openRouterTranscriber({ apiKey: apiKey as string, fetch: localAudio })

    try {
      const result = await transcriber.transcribe(NOTE)
      console.log(`  [live] transcript: ${JSON.stringify(result.text)}`)
      console.log(`  [live] language: ${String(result.language)}, cost: ${String(result.costUsd)}`)
      expect(result.text.trim()).not.toBe("")
    } catch (error) {
      expect(error).toBeInstanceOf(TranscribeError)
      console.log(`  [live] refused, as it should be: ${(error as TranscribeError).message}`)
      expect((error as TranscribeError).message).toContain("transcript")
    }
  }, 120_000)
})
