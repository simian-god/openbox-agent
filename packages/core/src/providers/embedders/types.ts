// DEP-2: an embedder, as the one function the core needs from it.
//
// Optional everywhere. KNOW-4 says the local retriever uses keyword
// ranking, and combines keyword and embedding scores only when an embedder
// is configured, so every path has to work without one.
export interface Embedder {
  id: string
  /**
   * One vector per text, in the same order.
   *
   * Batched because that is how every provider charges and rate limits:
   * indexing a knowledge folder is one call per batch rather than one per
   * chunk.
   */
  embed(texts: string[]): Promise<number[][]>
}

/**
 * How many texts go up in one embedding call.
 *
 * Here rather than in a retriever, because it is a property of how
 * embedding providers charge and rate limit, and both retrievers batch the
 * same way.
 */
export const EMBED_BATCH = 96

/** An embedding call that did not happen. */
export class EmbedError extends Error {
  readonly id: string
  readonly retryable: boolean

  constructor(id: string, message: string, retryable: boolean) {
    super(`${id}: ${message}`)
    this.name = "EmbedError"
    this.id = id
    this.retryable = retryable
  }
}
