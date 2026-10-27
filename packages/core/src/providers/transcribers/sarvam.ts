// MEDIA-1: Sarvam's speech to text, as a Transcriber.
//
// Built from Sarvam's published API reference on 2026-10-27 and NOT run
// against the real thing. That is deliberate and it is Known K21: proving
// it needs a key and, to mean anything, real voice notes in Indian
// languages and in Hinglish. Until then this is an adapter that matches
// the documentation, which is a weaker claim than the OpenRouter one.
//
// It ships at all because Sarvam is not on OpenRouter, checked against
// OpenRouter's live catalogue, and Saaras is the only route to the 22
// Indian languages it covers and the only one with a mode for code-mixed
// speech. That is the case Intent 17 names first.
//
// Four ways it differs from the OpenRouter adapter, each from the docs:
//
// - multipart/form-data with a `file` part, not JSON with base64.
// - the key goes in `api-subscription-key`, not an Authorization header.
// - the transcript is `transcript` and the language is `language_code`,
//   which is null when nothing was detected.
// - it reports NO cost and no duration. Sarvam bills per hour of audio
//   rather than per token, so there is nothing for LIMIT-3's pricing table
//   to price either, and a Sarvam transcription counts zero against the
//   spend cap. A known undercount, recorded rather than invented, which is
//   the same rule `costOf` follows for a model it does not know.
//
// The REST endpoint is meant for audio under 30 seconds; longer audio is
// Sarvam's Batch API, which this does not use. A voice note over that is
// the provider's error to report, not ours to guess at.
import type { FetchLike } from "../http.ts"
import {
  fetchAudio,
  formatFromMime,
  TranscribeError,
  type Transcriber,
  type TranscriberMedia,
  type Transcript,
} from "./types.ts"

const DEFAULT_BASE_URL = "https://api.sarvam.ai"

/** Pinned, so a new default cannot arrive under a running agent. */
export const DEFAULT_SARVAM_MODEL = "saaras:v4"

export interface SarvamTranscriberOptions {
  apiKey: string
  model?: string | undefined
  /**
   * `saaras:v3` only, per the docs. `codemix` is the one built for
   * Hinglish, so a builder who wants it must also pin the older model.
   */
  mode?: "transcribe" | "translate" | "verbatim" | "translit" | "codemix" | undefined
  baseUrl?: string | undefined
  fetch?: FetchLike | undefined
}

interface WireResponse {
  transcript?: unknown
  language_code?: unknown
  request_id?: unknown
}

export function sarvamTranscriber(options: SarvamTranscriberOptions): Transcriber {
  const id = "sarvam"
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const model = options.model ?? DEFAULT_SARVAM_MODEL
  const call = options.fetch ?? ((url, init) => fetch(url, init))

  return {
    id,

    async transcribe(media: TranscriberMedia): Promise<Transcript> {
      const bytes = await fetchAudio(id, media, call)

      const form = new FormData()
      const format = formatFromMime(media.mime)
      form.append("file", new Blob([bytes], { type: media.mime }), `audio.${format}`)
      form.append("model", model)
      // `unknown` is the documented way to ask it to detect the language,
      // which is what MEDIA-3 wants. Leaving it out does the same thing,
      // but saying so means a future default cannot change the answer.
      form.append("language_code", "unknown")
      if (options.mode !== undefined) form.append("mode", options.mode)

      let response: Response
      try {
        response = await call(`${baseUrl}/speech-to-text`, {
          method: "POST",
          // No Content-Type: the boundary has to come from FormData, and
          // setting it by hand is how multipart requests get corrupted.
          headers: { "api-subscription-key": options.apiKey },
          body: form,
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
      if (typeof payload.transcript !== "string") {
        throw new TranscribeError(id, "no transcript came back", true)
      }

      const text = payload.transcript.trim()
      if (text === "") {
        throw new TranscribeError(id, "the transcript was empty", false)
      }

      return {
        text,
        // Documented as null when nothing was detected, so the check is
        // for a usable string rather than for the field being present.
        ...(typeof payload.language_code === "string" && payload.language_code !== ""
          ? { language: payload.language_code }
          : {}),
        // No costUsd and no seconds on purpose. See the note at the top.
      }
    },
  }
}
