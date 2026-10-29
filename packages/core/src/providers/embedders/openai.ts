// DEP-2: OpenAI embeddings, as an Embedder.
//
// Checked against OpenAI's own API reference on 2026-10-28, and two things
// it says changed how this is written:
//
// - `data` is NOT promised to come back in the order the inputs went up.
//   Every item carries an `index` instead, and the docs say to map by it.
//   So this does, rather than trusting position: a silent reordering would
//   attach every chunk's vector to the wrong chunk, and the only symptom
//   would be search quietly getting worse.
// - an input may not be an empty string, and each is capped at 8192
//   tokens with 300,000 across one request. The empty one is refused here
//   with a message that says which, because the alternative is a 400 from
//   the vendor naming an index nobody can trace back.
//
// Built from the documentation and not run against the real API: the
// builder has parked OpenAI, so there is no key here. That is the same
// position the Sarvam transcriber is in and it is recorded the same way,
// in Known K28, because an adapter proven only against recorded responses
// shows that it matches the documentation and nothing more.
import type { FetchLike } from "../http.ts"
import { EmbedError, type Embedder } from "./types.ts"

const DEFAULT_BASE_URL = "https://api.openai.com/v1"

/** Pinned, so a new default cannot arrive under a running agent. */
export const DEFAULT_EMBED_MODEL = "text-embedding-3-small"

export interface OpenaiEmbedderOptions {
  apiKey: string
  model?: string | undefined
  /** `text-embedding-3` and later only, per the docs. */
  dimensions?: number | undefined
  baseUrl?: string | undefined
  /** Injected so contract tests run without network (TEST-3). */
  fetch?: FetchLike | undefined
}

interface WireResponse {
  data?: { embedding?: unknown; index?: unknown }[]
  error?: { message?: unknown }
}

export function openaiEmbedder(options: OpenaiEmbedderOptions): Embedder {
  const id = "openai"
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const model = options.model ?? DEFAULT_EMBED_MODEL
  const call = options.fetch ?? ((url, init) => fetch(url, init))

  return {
    id,

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []

      const empty = texts.findIndex((text) => text.trim() === "")
      if (empty !== -1) {
        throw new EmbedError(id, `text ${empty} is empty, which the API refuses`, false)
      }

      let response: Response
      try {
        response = await call(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: texts,
            encoding_format: "float",
            ...(options.dimensions !== undefined ? { dimensions: options.dimensions } : {}),
          }),
        })
      } catch (error) {
        throw new EmbedError(id, `request failed: ${String(error)}`, true)
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500
        throw new EmbedError(id, `HTTP ${response.status} ${detail.slice(0, 300)}`, retryable)
      }

      const payload = (await response.json().catch(() => ({}))) as WireResponse
      if (!Array.isArray(payload.data)) {
        const said = typeof payload.error?.message === "string" ? payload.error.message : ""
        throw new EmbedError(id, `no embeddings came back ${said}`.trim(), true)
      }

      // By `index`, not by position. See the note at the top of this file.
      const vectors: number[][] = Array.from({ length: texts.length })
      for (const item of payload.data) {
        if (!Array.isArray(item.embedding)) continue
        const at = typeof item.index === "number" ? item.index : -1
        if (at < 0 || at >= texts.length) continue
        vectors[at] = item.embedding as number[]
      }

      const missing = vectors.findIndex((vector) => vector === undefined)
      if (missing !== -1) {
        throw new EmbedError(id, `no embedding came back for text ${missing}`, true)
      }
      return vectors
    },
  }
}
