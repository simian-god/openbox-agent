// MEDIA-1: what a transcriber is, and the one piece of work both of them
// share.
//
// The interface is Spec section 4's, with two optional fields added so a
// transcription can reach the spend cap. See the decisions log: LIMIT-3
// says a call costs what the provider reported, and a transcriber that
// could not say what it cost would be the one paid call in the core that
// the cap cannot see.
//
// Both adapters need the audio itself, because neither API takes a URL.
// That is the reason `fetchAudio` lives here rather than in either one.
import type { FetchLike } from "../http.ts"

/** MEDIA-1: the channel's reference to the audio, never the audio itself. */
export interface TranscriberMedia {
  /** Where the channel keeps it. Fetched, never stored (MEDIA-1). */
  ref: string
  mime: string
}

export interface Transcript {
  text: string
  /** MEDIA-3: what the person was speaking, when the provider can tell. */
  language?: string | undefined
  /** LIMIT-3: what it cost, when the provider says. */
  costUsd?: number | undefined
  /** How much audio was charged for, when the provider says. */
  seconds?: number | undefined
}

export interface Transcriber {
  id: string
  transcribe(media: TranscriberMedia): Promise<Transcript>
}

/**
 * A transcription that did not happen.
 *
 * `retryable` has the same meaning it has for a brain: worth another go
 * with the same input. MEDIA-1's answer to a failure is to ask the person
 * to type, so the core does not retry this itself, but a glue that holds
 * the audio can.
 */
export class TranscribeError extends Error {
  readonly id: string
  readonly retryable: boolean

  constructor(id: string, message: string, retryable: boolean) {
    super(`${id}: ${message}`)
    this.name = "TranscribeError"
    this.id = id
    this.retryable = retryable
  }
}

/** How much audio either adapter will carry in one request. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/**
 * The audio behind a media ref, as bytes.
 *
 * Neither API takes a URL, so somebody has to fetch it, and a provider is
 * the only place in the core allowed to (DEP-1). Bounded on purpose: a ref
 * that points at something enormous is refused here rather than read into
 * memory and then refused by the vendor.
 */
export async function fetchAudio(
  id: string,
  media: TranscriberMedia,
  call: FetchLike,
): Promise<Uint8Array> {
  let response: Response
  try {
    response = await call(media.ref, { method: "GET" })
  } catch (error) {
    throw new TranscribeError(id, `could not fetch the audio: ${String(error)}`, true)
  }

  if (!response.ok) {
    // A ref that has expired is a 403 or 404 on most channels, and no
    // number of retries will bring it back.
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    throw new TranscribeError(id, `fetching the audio gave HTTP ${response.status}`, retryable)
  }

  const declared = Number(response.headers.get("content-length") ?? "0")
  if (declared > MAX_AUDIO_BYTES) {
    throw new TranscribeError(id, `the audio is ${declared} bytes, over the limit`, false)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new TranscribeError(id, `the audio is ${bytes.byteLength} bytes, over the limit`, false)
  }
  if (bytes.byteLength === 0) {
    throw new TranscribeError(id, "the audio was empty", false)
  }
  return bytes
}

/**
 * The format name an API wants, from the mime type a channel sent.
 *
 * WhatsApp sends `audio/ogg; codecs=opus`, so the parameters come off and
 * the subtype is what is left. `x-` prefixes are dropped because they are
 * the same format under an older name.
 */
export function formatFromMime(mime: string): string {
  const subtype = (mime.split(";")[0] ?? "").trim().split("/")[1] ?? ""
  const bare = subtype.replace(/^x-/, "").toLowerCase()
  // The two names that differ between channels and APIs.
  if (bare === "mpeg" || bare === "mpeg3") return "mp3"
  if (bare === "m4a" || bare === "mp4a-latm") return "mp4"
  return bare
}
