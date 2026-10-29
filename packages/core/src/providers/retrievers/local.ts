// KNOW-4: the `local` retriever. Keyword ranking, in process, with
// embeddings blended in when an embedder is configured.
//
// MiniSearch because Plan section 4 chose it: small, well tested and in
// process, so an agent that wants search needs no extra service. Checked
// against the installed 7.2.0 rather than remembered: `addAll` throws on
// an id it already has, which is why `index` discards first and is an
// upsert; `search` returns an unbounded `score` with the stored fields
// spread onto each result.
//
// Blending is the decision in this file, and it is not arithmetic.
//
// The two scores are not on the same scale. MiniSearch's score is
// unbounded and means "better than the others for this query", while
// cosine similarity is between -1 and 1 and means something absolute. Add
// them raw and whichever happens to be larger decides everything. So each
// half is normalised against the best match for that query and then
// weighted. The cost is that a score cannot be compared between two
// queries, which is fine: KNOW-3 only ever asks for the top few, and
// nothing in the Spec compares scores across searches. It is written down
// on `Found.score` so nobody builds a threshold on it later.
//
// A negative cosine is clamped to zero. Below zero means pointing the
// other way, which is not "slightly relevant", and letting it subtract
// would let an unrelated chunk pull down a real keyword match.
//
// The vectors live in memory, one per chunk. That is the price of in
// process search and it is bounded by the knowledge folder rather than by
// traffic: a thousand chunks at 1536 dimensions is about six megabytes.
import MiniSearch from "minisearch"
import type { KnowledgeDoc } from "../../knowledge/index.ts"
import { EMBED_BATCH, type Embedder } from "../embedders/types.ts"
import type { Found, Retriever } from "./types.ts"

/** How much each half counts when both are available (KNOW-4). */
export const DEFAULT_WEIGHTS = { keyword: 0.5, vector: 0.5 } as const

/**
 * How much misspelling to forgive, by how long the word is.
 *
 * Measured rather than chosen. A flat `fuzzy: 0.2` looks harmless and is
 * not: asked "what time do you open", it matched **time** against **lime**
 * on a drinks chunk and ranked that above the opening hours, because one
 * edit on a four letter word is most of the word. Short words carry the
 * least information and the most false matches, so they are matched
 * exactly, while a real typo in something like "reservaton" is still
 * forgiven.
 *
 * `prefix` stays on for everything, and it is what makes "open" find
 * "opening". Without it that question matches nothing at all.
 */
const FUZZY = (term: string): number | false => (term.length > 5 ? 0.2 : false)

export interface LocalRetrieverOptions {
  /** KNOW-4: blending is on only when one is given. */
  embedder?: Embedder | undefined
  /** How much each half counts. Defaults to half and half. */
  weights?: { keyword: number; vector: number } | undefined
}

interface Stored {
  id: string
  text: string
  source: string
}

/** Cosine similarity, or 0 when either vector says nothing. */
export function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftSize = 0
  let rightSize = 0
  for (let i = 0; i < left.length; i++) {
    const a = left[i] ?? 0
    const b = right[i] ?? 0
    dot += a * b
    leftSize += a * a
    rightSize += b * b
  }
  if (leftSize === 0 || rightSize === 0) return 0
  return dot / (Math.sqrt(leftSize) * Math.sqrt(rightSize))
}

/** Each score over the best one, so both halves land in 0 to 1. */
function normalise(scores: Map<string, number>): Map<string, number> {
  let best = 0
  for (const score of scores.values()) best = Math.max(best, score)
  if (best <= 0) return new Map()
  const out = new Map<string, number>()
  for (const [id, score] of scores) out.set(id, score / best)
  return out
}

export function localRetriever(options: LocalRetrieverOptions = {}): Retriever {
  const weights = options.weights ?? DEFAULT_WEIGHTS
  const docs = new Map<string, Stored>()
  const vectors = new Map<string, number[]>()

  const build = (): MiniSearch<Stored> =>
    new MiniSearch<Stored>({
      // The chunk's text already carries its heading (KNOW-1), so one
      // field is enough and the heading is searchable through it.
      fields: ["text"],
      storeFields: ["text", "source"],
      idField: "id",
    })

  let engine = build()

  return {
    id: "local",

    async index(incoming: KnowledgeDoc[]): Promise<void> {
      if (incoming.length === 0) return

      for (const doc of incoming)
        docs.set(doc.id, { id: doc.id, text: doc.text, source: doc.source })

      // Rebuilt rather than patched. `discard` leaves the id behind until
      // a vacuum and the index is small enough that honesty beats
      // cleverness here: one pass over the chunks of one agent's
      // knowledge folder.
      engine = build()
      engine.addAll([...docs.values()])

      if (options.embedder !== undefined) {
        const missing = [...docs.values()].filter((doc) => !vectors.has(doc.id))
        for (let at = 0; at < missing.length; at += EMBED_BATCH) {
          const batch = missing.slice(at, at + EMBED_BATCH)
          const embedded = await options.embedder.embed(batch.map((doc) => doc.text))
          batch.forEach((doc, index) => {
            const vector = embedded[index]
            if (vector !== undefined) vectors.set(doc.id, vector)
          })
        }
      }
    },

    async search(query: string, k: number): Promise<Found[]> {
      if (query.trim() === "" || docs.size === 0 || k <= 0) return []

      const keyword = new Map<string, number>()
      for (const hit of engine.search(query, { prefix: true, fuzzy: FUZZY })) {
        keyword.set(String(hit.id), hit.score)
      }

      // KNOW-4: keyword ranking alone unless an embedder was configured.
      if (options.embedder === undefined || vectors.size === 0) {
        return rank(keyword, docs, k)
      }

      const [asked] = await options.embedder.embed([query])
      if (asked === undefined) return rank(keyword, docs, k)

      const vector = new Map<string, number>()
      for (const [id, stored] of vectors) {
        // Clamped: pointing the other way is not slightly relevant.
        vector.set(id, Math.max(0, cosine(asked, stored)))
      }

      const byKeyword = normalise(keyword)
      const byVector = normalise(vector)
      const blended = new Map<string, number>()
      // Every document either half found, so a chunk with no keyword
      // match can still arrive on similarity, which is the point of
      // having both.
      for (const id of new Set([...byKeyword.keys(), ...byVector.keys()])) {
        blended.set(
          id,
          (byKeyword.get(id) ?? 0) * weights.keyword + (byVector.get(id) ?? 0) * weights.vector,
        )
      }
      return rank(blended, docs, k)
    },
  }
}

/** The best `k`, as what KNOW-3 returns. */
function rank(scores: Map<string, number>, docs: Map<string, Stored>, k: number): Found[] {
  return [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, k)
    .flatMap(([id, score]) => {
      const doc = docs.get(id)
      return doc === undefined ? [] : [{ text: doc.text, source: doc.source, score }]
    })
}
