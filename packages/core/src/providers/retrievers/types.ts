// DEP-2 and KNOW-3: a retriever, as the two things the core asks of it.
import type { KnowledgeDoc } from "../../knowledge/index.ts"

/** KNOW-3: one chunk a search found, and how well it matched. */
export interface Found {
  text: string
  /** KNOW-3: the source file or entry. `menu.md#Drinks`. */
  source: string
  /**
   * How well it matched, higher is better.
   *
   * Comparable within one search and not between two. Both halves of a
   * blended score are normalised against the best match for that query
   * (KNOW-4), which is what makes "the top 5" meaningful and a threshold
   * across queries meaningless. KNOW-3 only ever asks for the top few.
   */
  score: number
}

export interface Retriever {
  id: string
  /**
   * Adds documents to the index, replacing any with the same id.
   *
   * Additive rather than wholesale, because it is called twice for
   * different reasons: once at start with everything (KNOW-1), and again
   * with a single entry when an operator approves one, which KNOW-2 says
   * must take effect without a restart.
   */
  index(docs: KnowledgeDoc[]): Promise<void>
  /** KNOW-3: the best `k` chunks for this query. */
  search(query: string, k: number): Promise<Found[]>
}
