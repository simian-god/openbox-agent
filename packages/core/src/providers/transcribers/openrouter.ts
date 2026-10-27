// MEDIA-1: OpenRouter's transcription endpoint, as a Transcriber.
//
// The one to reach for (DEP-2). One key and one adapter reach 28 speech
// models, so changing model is a config line rather than a new provider.
//
// Checked against OpenRouter's own docs on 2026-10-27, and three of the
// things it said changed how this is written:
//
// - It is NOT the chat completions endpoint. `POST /audio/transcriptions`
//   takes `input_audio: { data, format }` where data is raw base64 and
//   explicitly not a data URI.
// - The default response is `{ text, usage }` and carries NO language.
//   MEDIA-3 needs one, so `response_format: "verbose_json"` is always
//   sent. Without it this adapter would silently never detect a language
//   and every person would be answered in the default.
// - `usage` carries `seconds` and `cost` in USD, so a transcription can
//   reach the LIMIT-3 spend cap like a brain call does.
//
// Audio goes up as bytes because the endpoint takes no URL, which is why
// the media ref is fetched first (MEDIA-1 keeps the ref, never the audio).
import type { FetchLike } from "../http.ts"
import {
  fetchAudio,
  formatFromMime,
  TranscribeError,
  type Transcriber,
  type TranscriberMedia,
  type Transcript,
} from "./types.ts"

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

/**
 * Pinned, not floating. ElevenLabs Scribe v2 advertises 90 or more
 * languages, which is the widest coverage on the endpoint, and K21 is the
 * open question of how it handles code-mixed Hinglish.
 */
export const DEFAULT_TRANSCRIBE_MODEL = "elevenlabs/scribe-v2"

export interface OpenRouterTranscriberOptions {
  apiKey: string
  model?: string | undefined
  baseUrl?: string | undefined
  /** Injected so contract tests run without network (TEST-3). */
  fetch?: FetchLike | undefined
  appUrl?: string | undefined
  appName?: string | undefined
}

/** The documented response, as the parts this adapter reads. */
interface WireResponse {
  text?: unknown
  language?: unknown
  usage?: { seconds?: unknown; cost?: unknown }
  error?: { message?: unknown }
}

export function openRouterTranscriber(options: OpenRouterTranscriberOptions): Transcriber {
  const id = "openrouter"
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const model = options.model ?? DEFAULT_TRANSCRIBE_MODEL
  const call = options.fetch ?? ((url, init) => fetch(url, init))

  return {
    id,

    async transcribe(media: TranscriberMedia): Promise<Transcript> {
      const bytes = await fetchAudio(id, media, call)

      const format = formatFromMime(media.mime)
      if (format === "") {
        throw new TranscribeError(id, `cannot tell the audio format from "${media.mime}"`, false)
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      }
      if (options.appUrl !== undefined) headers["HTTP-Referer"] = options.appUrl
      if (options.appName !== undefined) headers["X-Title"] = options.appName

      let response: Response
      try {
        response = await call(`${baseUrl}/audio/transcriptions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            input_audio: {
              // Raw base64. The docs say explicitly not a data URI.
              data: Buffer.from(bytes).toString("base64"),
              format,
            },
            // MEDIA-3 lives on this line. The default `json` response has
            // no language field at all, so without it nothing is detected.
            response_format: "verbose_json",
            // No `language` sent, so the provider detects it. Passing one
            // would tell it what to hear rather than ask what it heard.
          }),
        })
      } catch (error) {
        throw new TranscribeError(id, `request failed: ${String(error)}`, true)
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500
        throw new TranscribeError(id, `HTTP ${response.status} ${detail.slice(0, 300)}`, retryable)
      }

      const payload = (await response.json().catch(() => ({}))) as WireResponse
      if (typeof payload.text !== "string") {
        const said = typeof payload.error?.message === "string" ? payload.error.message : ""
        throw new TranscribeError(id, `no transcript came back ${said}`.trim(), true)
      }

      const text = payload.text.trim()
      if (text === "") {
        // Silence, or a voice note nobody spoke in. MEDIA-1's answer is to
        // ask the person to type, and an empty transcript used as the
        // message text would start a turn with nothing in it instead.
        throw new TranscribeError(id, "the transcript was empty", false)
      }

      return {
        text,
        ...(typeof payload.language === "string" && payload.language !== ""
          ? { language: payload.language }
          : {}),
        ...(typeof payload.usage?.cost === "number" ? { costUsd: payload.usage.cost } : {}),
        ...(typeof payload.usage?.seconds === "number" ? { seconds: payload.usage.seconds } : {}),
      }
    },
  }
}
