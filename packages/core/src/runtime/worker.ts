// LOOP-2 to LOOP-4: the worker that turns waiting messages into turns.
//
// `receive` only writes a message down. This is what picks it up. One
// process runs `workerConcurrency` people at a time; one person is always
// one turn at a time, because the worker holds their lease while it works.
//
// Throughput past one process comes from running more of them. Everything
// here is built for that:
//
//   - the claim is a conditional update (DATA-4), so two workers reaching
//     for the same person cannot both get them
//   - every query is indexed and has a limit, so a worker's cost does not
//     grow with the size of the inbox
//   - nothing is held open across a turn: no transaction, no long query
//   - a worker that dies loses its leases by expiry, and another takes the
//     people over without anyone having to notice
//
// A message received by this process is picked up at once rather than on
// the next poll, so the poll interval is a floor on how long a message can
// wait, not on how fast this process answers.
import type { OpenboxConfig } from "../config/index.ts"
import type { InboxRow, PersonRow, Store } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"
import type { EventWriter } from "./events.ts"
import type { Leases } from "./lease.ts"
import { createPump, type Pump } from "./pump.ts"
import type { TurnResult } from "./turn.ts"

export interface WorkerOptions {
  config: OpenboxConfig
  store: Store
  leases: Leases
  clock: Clock
  events: EventWriter
  /** Runs one turn for a person over the rows it was given. */
  runTurn: (person: PersonRow, batch: InboxRow[]) => Promise<TurnResult>
  /** Told when the worker itself, rather than a turn, went wrong. */
  onError?: ((error: unknown) => void) | undefined
}

/** The inbox worker is a pump over people (see pump.ts). */
export type Worker = Pump

export function createWorker(options: WorkerOptions): Worker {
  const { config, store, leases, clock, events, runTurn, onError } = options

  /**
   * LOOP-3: a person is ready when the burst window has passed since their
   * newest waiting message. Checked before claiming, so a person still
   * mid burst costs no claim and no release.
   */
  async function ready(personId: string): Promise<boolean> {
    const newest = await store.inbox.list(
      { person_id: personId, status: "pending" },
      { orderBy: "seq", ascending: false, limit: 1 },
    )
    const row = newest[0]
    if (row === undefined) return false

    const since = clock.now().getTime() - new Date(row.received_at).getTime()
    return since >= config.burstWindowMs
  }

  /** LOOP-3: every row this person has waiting, in arrival order. */
  async function batchFor(personId: string): Promise<InboxRow[]> {
    return store.inbox.list({ person_id: personId, status: "pending" }, { orderBy: "seq" })
  }

  /**
   * The people worth trying, oldest waiting message first.
   *
   * Bounded by how many rows it reads as well as by how many free slots
   * there are. It offers more people than slots so a worker losing races
   * to other workers still finds somebody to handle.
   */
  async function candidates(slots: number): Promise<string[]> {
    const rows = await store.inbox.list({ status: "pending" }, { orderBy: "seq", limit: slots * 8 })

    const seen = new Set<string>()
    for (const row of rows) {
      seen.add(row.person_id)
      if (seen.size >= slots * 2) break
    }

    const out: string[] = []
    for (const personId of seen) {
      if (await ready(personId)) out.push(personId)
    }
    return out
  }

  /**
   * One person, from claim to release.
   *
   * LOOP-4: a turn can finish with more rows already waiting, because they
   * arrived while it ran. Those get the next turn straight away, while the
   * lease is still held, rather than waiting for another worker to find
   * them.
   */
  async function handle(personId: string): Promise<void> {
    const lease = await leases.claim(personId)
    if (lease === null) return

    // LOOP-2: renewed while the turn runs, so a turn slower than the lease
    // never loses the person halfway through.
    const renewal = setInterval(
      () => {
        leases.renew(personId).then((kept) => {
          if (!kept) report(new Error(`the lease on person ${personId} was lost mid turn`))
        }, report)
      },
      Math.max(1_000, (config.leaseSeconds * 1000) / 3),
    )

    try {
      const person = await store.people.byId(personId)
      if (person === null) return

      // Follow on turns, until this person has nothing left that is ready.
      for (;;) {
        const batch = await batchFor(personId)
        if (batch.length === 0) return

        // Re-checked now the rows are in hand: a message can arrive
        // between the check and the claim, and answering mid burst is the
        // one thing LOOP-3 exists to prevent.
        const newest = batch[batch.length - 1]
        if (newest === undefined) return
        const since = clock.now().getTime() - new Date(newest.received_at).getTime()
        if (since < config.burstWindowMs) return

        if (batch.length > 1) {
          await events
            .about({ personId })
            .record("burst_merged", { messages: batch.length, inboxIds: batch.map((r) => r.id) })
        }

        await runTurn(person, batch)
      }
    } finally {
      clearInterval(renewal)
      await leases.release(personId).catch(report)
    }
  }

  function report(error: unknown): void {
    try {
      onError?.(error)
    } catch {
      // A broken handler must not stop the worker looking for work.
    }
  }

  return createPump<string>({
    pollMs: config.workerPollMs,
    concurrency: config.workerConcurrency,
    candidates,
    // One person is one turn at a time, here as well as across processes.
    key: (personId) => personId,
    handle,
    ...(onError !== undefined ? { onError } : {}),
  })
}
