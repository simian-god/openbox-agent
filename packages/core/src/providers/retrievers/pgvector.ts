// KNOW-4: the `pgvector` retriever. Chunks and embeddings in Postgres,
// with the ranking done there too.
//
// This file opens its own Postgres connection, which no other part of the
// running core does. It is deliberate and it is the reason this retriever
// exists at all.
//
// The agent reaches its data through supabase-js, over PostgREST. PostgREST
// cannot express `<=>`, pgvector's distance operator, and the usual way
// round that is a stored function, which DATA-3 rules out in as many
// words. So either the ranking happens here, over a real connection, or it
// happens in the agent's memory over every row in the table. The second is
// what the `local` retriever already does, which would leave this one
// buying nothing but persistence. It ranks in the database.
//
// DEP-1 allows it: this is `providers/`, the one folder that may reach the
// outside world, and `migrate` already opens the same kind of connection
// for the same kind of reason. The cost is real and belongs in the docs: an
// agent on this retriever needs a Postgres connection string, not just the
// Supabase URL and key, so a host that only allows outbound HTTP cannot
// use it.
//
// There is no keyword half here. KNOW-4 gives keyword ranking to the
// `local` retriever and says of this one only that it stores chunks and
// embeddings, so an embedder is required rather than optional, and
// `providersFromConfig` refuses to start without one.
import { SQL } from "bun"
import type { KnowledgeDoc } from "../../knowledge/index.ts"
import { EMBED_BATCH, type Embedder } from "../embedders/types.ts"
import type { Found, Retriever } from "./types.ts"

/** The table the optional migration creates. */
export const PGVECTOR_TABLE = "ob_knowledge_chunks"

/**
 * The width declared by the optional migration.
 *
 * Changing an embedder means changing both, which is why the mismatch is
 * reported by name rather than left to Postgres.
 */
export const PGVECTOR_DIMENSIONS = 1536

export interface PgvectorRetrieverOptions {
  /** DATA-1: whose chunks these are. `config.name`. */
  agentId: string
  /** Required, unlike the local retriever's. See the note above. */
  embedder: Embedder
  /** Opens its own connection and keeps it. */
  databaseUrl?: string | undefined
  /** An open connection to use instead. It is left open for the caller. */
  sql?: SQL | undefined
  /** Only for a test that wants a narrower column. */
  dimensions?: number | undefined
}

/**
 * Postgres for "that table is not there".
 *
 * Checked against Bun 1.4.0 rather than assumed: the SQLSTATE arrives on
 * `errno`, while `code` holds Bun's own `ERR_POSTGRES_SERVER_ERROR`.
 */
const UNDEFINED_TABLE = "42P01"

/**
 * Turns the one mistake a builder will certainly make into advice.
 *
 * Naming pgvector in config and not running its migration leaves a
 * correctly configured agent failing on the first question with
 * `relation "ob_knowledge_chunks" does not exist`, which says nothing
 * about what to do about it.
 */
async function withTable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if ((error as { errno?: unknown }).errno === UNDEFINED_TABLE) {
      throw new Error(
        `${PGVECTOR_TABLE} is not there. The pgvector retriever keeps its chunks in a table of its own, which is a separate migration: run "openbox migrate --pgvector"`,
        { cause: error },
      )
    }
    throw error
  }
}

/** pgvector reads a vector from `[1,2,3]`, so it goes over as text. */
function literal(vector: number[]): string {
  return `[${vector.join(",")}]`
}

export function pgvectorRetriever(options: PgvectorRetrieverOptions): Retriever {
  const width = options.dimensions ?? PGVECTOR_DIMENSIONS
  const { agentId, embedder } = options

  if (options.sql === undefined && options.databaseUrl === undefined) {
    throw new Error("the pgvector retriever needs either a databaseUrl or an open sql connection")
  }

  const sql = options.sql ?? new SQL({ url: options.databaseUrl as string, max: 2 })

  /** Checked here so the message names the embedder, not the column. */
  const checked = (vectors: number[][], texts: string[]): number[][] => {
    vectors.forEach((vector, at) => {
      if (vector.length !== width) {
        throw new Error(
          `the ${embedder.id} embedder returned ${vector.length} numbers for ${
            texts[at] === undefined ? "a chunk" : `"${texts[at]?.slice(0, 40)}"`
          }, and ${PGVECTOR_TABLE}.embedding holds ${width}. Change the width in the pgvector migration, or the embedder`,
        )
      }
    })
    return vectors
  }

  return {
    id: "pgvector",

    async index(incoming: KnowledgeDoc[]): Promise<void> {
      if (incoming.length === 0) return
      return withTable(async () => {
        // One chunk, one id, however many times a folder is loaded.
        const byId = new Map(incoming.map((entry) => [entry.id, entry]))
        const ids = [...byId.keys()]

        // Only what is not stored yet gets embedded. An id is a hash of the
        // text (KNOW-1), so an id already here is the same text, and
        // embedding is what a provider charges for: approving one entry must
        // not pay for the whole folder again.
        const present = (await sql`
        select id from ${sql.unsafe(PGVECTOR_TABLE)}
        where agent_id = ${agentId} and id in ${sql(ids)}
      `) as { id: string }[]

        for (const row of present) byId.delete(row.id)
        const missing = [...byId.values()]
        if (missing.length === 0) return

        for (let at = 0; at < missing.length; at += EMBED_BATCH) {
          const batch = missing.slice(at, at + EMBED_BATCH)
          const texts = batch.map((entry) => entry.text)
          const vectors = checked(await embedder.embed(texts), texts)

          // Upsert rather than insert, so two processes indexing the same
          // folder at once end with one row each rather than one failing.
          for (const [index, entry] of batch.entries()) {
            const vector = vectors[index]
            if (vector === undefined) continue
            await sql`
            insert into ${sql.unsafe(PGVECTOR_TABLE)} (agent_id, id, text, source, embedding)
            values (${agentId}, ${entry.id}, ${entry.text}, ${entry.source}, ${literal(vector)}::vector)
            on conflict (agent_id, id) do update
              set text = excluded.text, source = excluded.source, embedding = excluded.embedding
          `
          }
        }
      })
    },

    async search(query: string, k: number): Promise<Found[]> {
      if (query.trim() === "" || k <= 0) return []
      return withTable(async () => {
        const [asked] = checked(await embedder.embed([query]), [query])
        if (asked === undefined) return []

        // `<=>` is cosine distance, 0 for the same direction and 2 for the
        // opposite, so the score KNOW-3 wants is one minus it. Clamped at
        // zero like the local retriever's: pointing the other way is not
        // slightly relevant, and the filter drops it rather than ranking it.
        const rows = (await sql`
        select text, source, 1 - (embedding <=> ${literal(asked)}::vector) as score
        from ${sql.unsafe(PGVECTOR_TABLE)}
        where agent_id = ${agentId}
        order by embedding <=> ${literal(asked)}::vector
        limit ${k}
      `) as { text: string; source: string; score: number }[]

        return rows
          .map((row) => ({ text: row.text, source: row.source, score: Number(row.score) }))
          .filter((found) => found.score > 0)
      })
    },
  }
}
