// LOOP-2 and DATA-4: owning a person while you handle them.
//
// While a lease is held, no other process will handle that person. That
// guarantee has to live in the database, because it has to hold across
// processes and not just across code paths in one of them. It is what makes
// running more workers safe, which is the only way throughput goes up: one
// person is always one turn at a time.
//
// DATA-4: the claim is one conditional update, issued through supabase-js
// filters, with no RPC. Postgres takes a row lock for the update, so of
// several workers reaching for the same person exactly one wins and the
// rest come back empty.
//
// TIME-1: expiry is compared against the injected clock, never the
// database's `now()`. Two processes whose clocks disagree can therefore
// disagree about whether a lease is free, which is why leases are a minute
// long and renewed rather than seconds long. The Plan records the risk.
import type { LeaseRow, Store } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"

/** The part of the store a lease needs. */
export interface LeaseStore {
  leases: Pick<Store["leases"], "find" | "insert" | "update" | "list">
}

export interface LeaseOptions {
  store: LeaseStore
  clock: Clock
  /** Which process this is. Recorded on the row it holds. */
  owner: string
  /** LOOP-2: how long a claim lasts before it expires. */
  seconds: number
}

/** A lease row that has never been claimed starts here, in the past. */
export const FREE = "1970-01-01T00:00:00.000Z"

const plusSeconds = (at: Date, seconds: number): string =>
  new Date(at.getTime() + seconds * 1000).toISOString()

export interface Leases {
  /**
   * Takes this person, or returns null because someone else holds them.
   *
   * One round trip in the normal case. The second trip only happens for a
   * person whose lease row is missing, which is a person created before
   * migration 0004 ran.
   */
  claim(personId: string): Promise<LeaseRow | null>
  /** Pushes the expiry out. False means the lease is no longer ours. */
  renew(personId: string): Promise<boolean>
  /** Gives the person up, so another worker can take them at once. */
  release(personId: string): Promise<void>
  /** Every person this process currently holds. */
  held(): Promise<LeaseRow[]>
}

export function createLeases(options: LeaseOptions): Leases {
  const { store, clock, owner, seconds } = options

  /** The conditional update DATA-4 asks for. */
  async function take(personId: string): Promise<LeaseRow | null> {
    const now = clock.now()
    const rows = await store.leases.update(
      // The expected state: free, meaning its expiry has passed.
      { person_id: personId },
      { owner, expires_at: plusSeconds(now, seconds) },
      { lt: { expires_at: now.toISOString() } },
    )
    return rows[0] ?? null
  }

  return {
    async claim(personId: string): Promise<LeaseRow | null> {
      const taken = await take(personId)
      if (taken !== null) return taken

      // Either somebody holds them, or there is no row to update. Only the
      // second is worth another trip.
      const existing = await store.leases.find({ person_id: personId })
      if (existing !== null) return null

      try {
        await store.leases.insert({ person_id: personId, expires_at: FREE })
      } catch {
        // Another worker created it in the meantime, which is fine: the
        // claim below decides who gets it either way.
      }
      return take(personId)
    },

    async renew(personId: string): Promise<boolean> {
      // Ours, and still ours: a lease we let expire may already belong to
      // someone else, and taking it back would mean two turns at once.
      const now = clock.now()
      const rows = await store.leases.update(
        { person_id: personId, owner },
        { expires_at: plusSeconds(now, seconds) },
        { gt: { expires_at: now.toISOString() } },
      )
      return rows.length > 0
    },

    async release(personId: string): Promise<void> {
      await store.leases.update({ person_id: personId, owner }, { expires_at: FREE })
    },

    async held(): Promise<LeaseRow[]> {
      return store.leases.list({ owner }, { orderBy: "expires_at" })
    },
  }
}
