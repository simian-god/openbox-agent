// LOOP-6 and MEDIA-1: turning a voice note into something a brain can read.
//
// The rule MEDIA-1 states and the reason this is not inline in the turn:
// the transcript becomes the message's text, the audio is never stored,
// only the channel's reference to it, and when there is no transcriber or
// it fails, the person is asked to type instead. That last clause is the
// one worth keeping honest. A failed transcription must not become an
// empty message that the brain then answers as though somebody had said
// nothing, and it must not become an exception that loses the turn.
//
// MEDIA-3's half is here too: the language the provider heard is passed
// back so the turn can store it on the person.
import type { Transcriber } from "../providers/transcribers/types.ts"

/** MEDIA-1: what a person gets when their voice note could not be heard. */
export const TYPE_INSTEAD_REPLY =
  "Sorry, I could not make out that voice note. Could you type what you need instead?"

/**
 * MEDIA-2: what a person gets when no brain here can read a picture.
 *
 * It says what cannot be done and what to do instead, because a person who
 * has just sent a photo of a menu needs the way forward, not an apology.
 * A caption they sent with it is still answered, so this line and a real
 * answer can both arrive.
 */
export const CANNOT_READ_IMAGES_REPLY =
  "Sorry, I cannot look at pictures. Could you tell me in words what you need?"

/** One item of media on an inbound message, as the channel described it. */
export interface MediaItem {
  kind: string
  ref: string
  mime: string
  caption?: string | undefined
}

/** What one message turns into once anything audible has been heard. */
export interface Heard {
  /** What the message row stores as its text, transcript included. */
  text: string
  /** MEDIA-1: the words, kept apart from the text actually used. */
  transcript: string | null
  /** MEDIA-2: the pictures, for a brain that can look at them. */
  images: { ref: string; mime: string }[]
}

export interface ListenResult {
  /** Keyed by inbox row id. A row with no audio is absent. */
  heard: Map<string, Heard>
  /** MEDIA-1: true when at least one voice note could not be heard. */
  failed: boolean
  /** MEDIA-3: the first language anything was heard in. */
  language: string | undefined
  /** LIMIT-3: what the transcriptions cost, as the provider reported. */
  costUsd: number
}

/**
 * The audio items on a stored `media` column.
 *
 * The column is jsonb, so it is whatever was written rather than whatever
 * the type says. Anything that is not an object with a usable `ref` and
 * `mime` is dropped rather than trusted, because the alternative is a
 * request built out of a half row.
 */
export function audioIn(media: unknown): MediaItem[] {
  return mediaIn(media, "audio")
}

/** MEDIA-2: the image items on a stored `media` column, read the same way. */
export function imagesIn(media: unknown): MediaItem[] {
  return mediaIn(media, "image")
}

function mediaIn(media: unknown, kind: "audio" | "image"): MediaItem[] {
  if (!Array.isArray(media)) return []
  const items: MediaItem[] = []
  for (const entry of media) {
    if (entry === null || typeof entry !== "object") continue
    const item = entry as Record<string, unknown>
    if (item["kind"] !== kind) continue
    if (typeof item["ref"] !== "string" || item["ref"] === "") continue
    if (typeof item["mime"] !== "string" || item["mime"] === "") continue
    items.push({
      kind,
      ref: item["ref"],
      mime: item["mime"],
      ...(typeof item["caption"] === "string" ? { caption: item["caption"] } : {}),
    })
  }
  return items
}

export interface ListenOptions {
  batch: { id: string; text: string | null; media: unknown }[]
  /** MEDIA-1: absent is a supported configuration, not a fault. */
  transcriber?: Transcriber | undefined
  /** EVT-2's `transcribed`, recorded for every attempt, good or bad. */
  record: (name: "transcribed", props: Record<string, unknown>) => Promise<void> | void
}

/**
 * Transcribes every voice note in a batch.
 *
 * Never throws. A transcription that fails is reported in the result and
 * recorded in the trace, because MEDIA-1's answer to a failure is a
 * sentence to the person, not a lost turn.
 *
 * Sequential on purpose. A burst of three voice notes is three requests
 * either way, and doing them one at a time keeps the order of the
 * conversation and keeps one person from being a thundering herd.
 */
export async function listen(options: ListenOptions): Promise<ListenResult> {
  const { batch, transcriber, record } = options
  const heard = new Map<string, Heard>()
  let failed = false
  let language: string | undefined
  let costUsd = 0

  for (const row of batch) {
    const audio = audioIn(row.media)
    const pictures = imagesIn(row.media)
    // Nothing attached, so nothing to do and no row in the result.
    if (audio.length === 0 && pictures.length === 0) continue

    const words: string[] = []
    let anyHere = false

    for (const item of audio) {
      if (transcriber === undefined) {
        // MEDIA-1's first clause. Recorded, because "the agent has no
        // transcriber" and "the transcriber broke" look identical to the
        // person and should not in the trace.
        failed = true
        await record("transcribed", { ok: false, why: "no transcriber is configured" })
        continue
      }

      try {
        const result = await transcriber.transcribe({ ref: item.ref, mime: item.mime })
        words.push(result.text)
        anyHere = true
        if (language === undefined && result.language !== undefined) language = result.language
        if (result.costUsd !== undefined) costUsd += result.costUsd
        await record("transcribed", {
          ok: true,
          provider: transcriber.id,
          ...(result.language !== undefined ? { language: result.language } : {}),
          ...(result.seconds !== undefined ? { seconds: result.seconds } : {}),
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          characters: result.text.length,
        })
      } catch (error) {
        failed = true
        await record("transcribed", {
          ok: false,
          provider: transcriber.id,
          why: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const transcript = anyHere ? words.join("\n").trim() : null
    // Captions from everything attached. Somebody who sends a photo and
    // types a word with it meant both, and MEDIA-2 says the caption is
    // the text when the picture cannot be read.
    const captions = [...audio, ...pictures]
      .map((item) => item.caption)
      .filter((caption): caption is string => caption !== undefined && caption.trim() !== "")
    const parts = [row.text ?? "", ...captions, transcript ?? ""]
      .map((part) => part.trim())
      .filter((part) => part !== "")

    heard.set(row.id, {
      text: parts.join("\n"),
      transcript,
      images: pictures.map((item) => ({ ref: item.ref, mime: item.mime })),
    })
  }

  return { heard, failed, language, costUsd }
}
