// MEDIA-1: the two transcribers, against recorded responses.
//
// Both are built from the vendors published API references, read on
// 2026-10-27, so these tests show the adapters match the documentation.
// Whether the documentation matches the vendor is a different claim: the
// OpenRouter one has a live test, and the Sarvam one deliberately does
// not, which is Known K21.
import { test, expect, describe } from "bun:test"
import {
  openRouterTranscriber,
  DEFAULT_TRANSCRIBE_MODEL,
} from "../../src/providers/transcribers/openrouter.ts"
import { sarvamTranscriber, DEFAULT_SARVAM_MODEL } from "../../src/providers/transcribers/sarvam.ts"
import {
  fetchAudio,
  formatFromMime,
  MAX_AUDIO_BYTES,
  TranscribeError,
} from "../../src/providers/transcribers/types.ts"
import type { FetchLike } from "../../src/providers/http.ts"

const NOTE = { ref: "https://channel.example/media/abc", mime: "audio/ogg; codecs=opus" }
const AUDIO = new Uint8Array([1, 2, 3, 4, 5])

interface Call {
  url: string
  init: RequestInit
}

/**
 * A fetch that serves the audio on a GET and one recorded answer on POST.
 *
 * Both adapters fetch the media ref first, so every test needs that half
 * whether it is about it or not.
 */
function serving(answer: unknown, status = 200, audio: Uint8Array = AUDIO) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    if ((init.method ?? "GET") === "GET") return new Response(audio, { status: 200 })
    return new Response(JSON.stringify(answer), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }
  return { fetch, calls, post: () => calls.find((c) => c.init.method === "POST") }
}

const OK_OPENROUTER = {
  text: "do you have a table for four",
  language: "en",
  usage: { seconds: 3.5, cost: 0.0002 },
}

describe("MEDIA-1: the OpenRouter transcriber", () => {
  test("MEDIA-1: the transcript comes back as the text", async () => {
    const { fetch } = serving(OK_OPENROUTER)
    const result = await openRouterTranscriber({ apiKey: "sk-test", fetch }).transcribe(NOTE)

    expect(result.text).toBe("do you have a table for four")
  })

  test("MEDIA-1: it posts to the transcription endpoint, not chat completions", async () => {
    const { fetch, post } = serving(OK_OPENROUTER)
    await openRouterTranscriber({ apiKey: "sk-test", fetch }).transcribe(NOTE)

    expect(post()?.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions")
  })

  test("MEDIA-1: the audio goes up as raw base64, which is not a data URI", async () => {
    const { fetch, post } = serving(OK_OPENROUTER)
    await openRouterTranscriber({ apiKey: "sk-test", fetch }).transcribe(NOTE)

    const body = JSON.parse(String(post()?.init.body)) as {
      input_audio: { data: string; format: string }
    }
    expect(body.input_audio.data).toBe(Buffer.from(AUDIO).toString("base64"))
    // The docs say explicitly not a data URI, so this is worth pinning.
    expect(body.input_audio.data.startsWith("data:")).toBe(false)
    expect(body.input_audio.format).toBe("ogg")
  })

  test("MEDIA-3: verbose_json is always asked for, or no language comes back", async () => {
    // The whole of MEDIA-3 rests on this one field. The default response
    // format carries no language at all, so an adapter that left this out
    // would detect nothing and every person would get the default
    // language, silently and for ever.
    const { fetch, post } = serving(OK_OPENROUTER)
    await openRouterTranscriber({ apiKey: "sk-test", fetch }).transcribe(NOTE)

    const body = JSON.parse(String(post()?.init.body)) as { response_format: string }
    expect(body.response_format).toBe("verbose_json")
  })

  test("MEDIA-3: the language the provider heard is passed through", async () => {
    const { fetch } = serving(OK_OPENROUTER)
    const result = await openRouterTranscriber({ apiKey: "sk-test", fetch }).transcribe(NOTE)

    expect(result.language).toBe("en")
  })

  test("MEDIA-3: no language is sent, so the provider detects it", async () => {
    // Sending one would tell the provider what to hear instead of asking
    // what it heard, which is the opposite of detection.
    const { fetch, post } = serving(OK_OPENROUTER)
    await openRouterTranscriber({ apiKey: "sk-test", fetch }).transcribe(NOTE)

    const body = JSON.parse(String(post()?.init.body)) as Record<string, unknown>
    expect(body["language"]).toBeUndefined()
  })

  test("LIMIT-3: the cost and the seconds it reports are passed through", async () => {
    const { fetch } = serving(OK_OPENROUTER)
    const result = await openRouterTranscriber({ apiKey: "sk-test", fetch }).transcribe(NOTE)

    expect(result.costUsd).toBe(0.0002)
    expect(result.seconds).toBe(3.5)
  })

  test("LIMIT-3: a run that reports no cost is not given one", async () => {
    const { fetch } = serving({ text: "hello" })
    const result = await openRouterTranscriber({ apiKey: "sk-test", fetch }).transcribe(NOTE)

    expect(result.costUsd).toBeUndefined()
    expect(result.language).toBeUndefined()
  })

  test("DEP-2: the model is pinned, and config can change it", async () => {
    const first = serving(OK_OPENROUTER)
    await openRouterTranscriber({ apiKey: "sk-test", fetch: first.fetch }).transcribe(NOTE)
    expect((JSON.parse(String(first.post()?.init.body)) as { model: string }).model).toBe(
      DEFAULT_TRANSCRIBE_MODEL,
    )

    const other = serving(OK_OPENROUTER)
    await openRouterTranscriber({
      apiKey: "sk-test",
      fetch: other.fetch,
      model: "openai/whisper-large-v3",
    }).transcribe(NOTE)
    expect((JSON.parse(String(other.post()?.init.body)) as { model: string }).model).toBe(
      "openai/whisper-large-v3",
    )
  })

  test("CFG-2: the key goes in the Authorization header", async () => {
    const { fetch, post } = serving(OK_OPENROUTER)
    await openRouterTranscriber({ apiKey: "sk-secret", fetch }).transcribe(NOTE)

    const headers = post()?.init.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer sk-secret")
  })

  test("MEDIA-1: an empty transcript is a failure, not an empty message", async () => {
    // Silence, or a voice note nobody spoke in. Used as the message text
    // it would start a turn with nothing in it, and the brain would
    // answer a person who had not said anything.
    const { fetch } = serving({ text: "   " })
    const error = (await openRouterTranscriber({ apiKey: "sk-test", fetch })
      .transcribe(NOTE)
      .catch((e: unknown) => e)) as TranscribeError

    expect(error).toBeInstanceOf(TranscribeError)
    expect(error.retryable).toBe(false)
  })

  test("MEDIA-1: a 500 is worth another go, a 400 is not", async () => {
    for (const [status, retryable] of [
      [500, true],
      [429, true],
      [408, true],
      [400, false],
      [401, false],
    ] as const) {
      const { fetch } = serving({ error: { message: "nope" } }, status)
      const error = (await openRouterTranscriber({ apiKey: "sk-test", fetch })
        .transcribe(NOTE)
        .catch((e: unknown) => e)) as TranscribeError
      expect(error.retryable).toBe(retryable)
    }
  })
})

describe("MEDIA-1: the Sarvam transcriber", () => {
  // Hinglish on purpose. Code-mixed speech is the whole reason this
  // adapter ships at all, and the whole of what K21 cannot yet prove.
  const OK = {
    request_id: "r1",
    transcript: "chaar logon ke liye table hai kya",
    language_code: "hi-IN",
  }

  test("MEDIA-1: the transcript field is read and used as the text", async () => {
    const { fetch } = serving(OK)
    const result = await sarvamTranscriber({ apiKey: "k", fetch }).transcribe(NOTE)

    expect(result.text).toBe("chaar logon ke liye table hai kya")
  })

  test("MEDIA-1: it posts multipart to the speech-to-text endpoint", async () => {
    const { fetch, post } = serving(OK)
    await sarvamTranscriber({ apiKey: "k", fetch }).transcribe(NOTE)

    expect(post()?.url).toBe("https://api.sarvam.ai/speech-to-text")
    expect(post()?.init.body).toBeInstanceOf(FormData)
  })

  test("CFG-2: the key goes in api-subscription-key, not Authorization", async () => {
    const { fetch, post } = serving(OK)
    await sarvamTranscriber({ apiKey: "k-secret", fetch }).transcribe(NOTE)

    const headers = post()?.init.headers as Record<string, string>
    expect(headers["api-subscription-key"]).toBe("k-secret")
    expect(headers["Authorization"]).toBeUndefined()
  })

  test("MEDIA-1: no Content-Type is set, so FormData supplies the boundary", async () => {
    // Setting it by hand is how a multipart request arrives corrupted:
    // the boundary in the header has to match the one in the body.
    const { fetch, post } = serving(OK)
    await sarvamTranscriber({ apiKey: "k", fetch }).transcribe(NOTE)

    const headers = post()?.init.headers as Record<string, string>
    expect(headers["Content-Type"]).toBeUndefined()
  })

  test("MEDIA-3: language_code goes up as unknown, so it detects", async () => {
    const { fetch, post } = serving(OK)
    await sarvamTranscriber({ apiKey: "k", fetch }).transcribe(NOTE)

    const body = post()?.init.body as FormData
    expect(body.get("language_code")).toBe("unknown")
    expect(body.get("model")).toBe(DEFAULT_SARVAM_MODEL)
  })

  test("MEDIA-3: the detected language comes back", async () => {
    const { fetch } = serving(OK)
    const result = await sarvamTranscriber({ apiKey: "k", fetch }).transcribe(NOTE)

    expect(result.language).toBe("hi-IN")
  })

  test("MEDIA-3: a null language_code is no language, not the string null", async () => {
    // Documented as null when nothing was detected.
    const { fetch } = serving({ transcript: "hello", language_code: null })
    const result = await sarvamTranscriber({ apiKey: "k", fetch }).transcribe(NOTE)

    expect(result.language).toBeUndefined()
  })

  test("LIMIT-3: Sarvam reports no cost, and none is invented", async () => {
    // It bills per hour of audio rather than per token, so there is
    // nothing for the pricing table to price either. A known undercount,
    // written down in K21 rather than guessed at.
    const { fetch } = serving(OK)
    const result = await sarvamTranscriber({ apiKey: "k", fetch }).transcribe(NOTE)

    expect(result.costUsd).toBeUndefined()
    expect(result.seconds).toBeUndefined()
  })

  test("the codemix mode can be asked for, which is the Hinglish one", async () => {
    const { fetch, post } = serving(OK)
    await sarvamTranscriber({
      apiKey: "k",
      fetch,
      mode: "codemix",
      model: "saaras:v3",
    }).transcribe(NOTE)

    const body = post()?.init.body as FormData
    expect(body.get("mode")).toBe("codemix")
    expect(body.get("model")).toBe("saaras:v3")
  })
})

describe("MEDIA-1: fetching the audio, which both of them do", () => {
  const anyFetch =
    (response: Response): FetchLike =>
    async () =>
      response

  test("MEDIA-1: the media ref is fetched, and the audio is never stored", async () => {
    const { fetch, calls } = serving({ text: "hi" })
    await openRouterTranscriber({ apiKey: "sk-test", fetch }).transcribe(NOTE)

    expect(calls[0]?.url).toBe(NOTE.ref)
    expect(calls[0]?.init.method).toBe("GET")
  })

  test("a ref that has expired is not worth retrying", async () => {
    for (const [status, retryable] of [
      [404, false],
      [403, false],
      [500, true],
      [429, true],
    ] as const) {
      const error = (await fetchAudio("t", NOTE, anyFetch(new Response("", { status }))).catch(
        (e: unknown) => e,
      )) as TranscribeError
      expect(error.retryable).toBe(retryable)
    }
  })

  test("audio over the limit is refused rather than read into memory", async () => {
    const headers = { "content-length": String(MAX_AUDIO_BYTES + 1) }
    const error = (await fetchAudio(
      "t",
      NOTE,
      anyFetch(new Response("x", { status: 200, headers })),
    ).catch((e: unknown) => e)) as TranscribeError

    expect(error).toBeInstanceOf(TranscribeError)
    expect(error.message).toContain("over the limit")
    expect(error.retryable).toBe(false)
  })

  test("empty audio is a failure, so MEDIA-1 asks the person to type", async () => {
    const error = (await fetchAudio(
      "t",
      NOTE,
      anyFetch(new Response(new Uint8Array([]), { status: 200 })),
    ).catch((e: unknown) => e)) as TranscribeError

    expect(error).toBeInstanceOf(TranscribeError)
    expect(error.retryable).toBe(false)
  })

  test("a channel's mime type becomes the format an API wants", () => {
    // WhatsApp sends the first of these, which is the case that matters.
    expect(formatFromMime("audio/ogg; codecs=opus")).toBe("ogg")
    expect(formatFromMime("audio/mpeg")).toBe("mp3")
    expect(formatFromMime("audio/x-m4a")).toBe("mp4")
    expect(formatFromMime("audio/wav")).toBe("wav")
    expect(formatFromMime("audio/WAV")).toBe("wav")
    expect(formatFromMime("nonsense")).toBe("")
  })

  test("a mime type nothing can be made of is refused, not guessed", async () => {
    const { fetch } = serving({ text: "hi" })
    const error = (await openRouterTranscriber({ apiKey: "sk-test", fetch })
      .transcribe({ ref: NOTE.ref, mime: "nonsense" })
      .catch((e: unknown) => e)) as TranscribeError

    expect(error).toBeInstanceOf(TranscribeError)
    expect(error.retryable).toBe(false)
  })
})
