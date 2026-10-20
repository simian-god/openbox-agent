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

export interface Worker {
  /** Begins looking for work. Calling it twice changes nothing. */
  start(): void
  /** Stops looking, waits for turns in flight, and gives up every lease. */
  stop(): Promise<void>
  /** Look now rather than on the next poll. Never throws. */
  nudge(): void
  /** Waits for the turns in flight, without stopping the poll. */
  drain(): Promise<void>
  /** How many people this worker is handling right now. */
  busy(): number
  readonly running: boolean
}

export function createWorker(options: WorkerOptions): Worker {
  const { config, store, leases, clock, events, runTurn, onError } = options

  /** The people being handled right now, by id. */
  const active = new Map<string, Promise<void>>()
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Set while a sweep is in progress, so two never overlap. */
  let sweeping = false
  /** True when a nudge arrived during a sweep, so one more is owed. */
  let again = false

  const report = (error: unknown): void => {
    try {
      onError?.(error)
    } catch {
      // A broken handler must not stop the worker looking for work.
    }
  }

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
   * Bounded twice over: by how many rows it reads, and by how many free
   * slots there are. It reads more candidates than slots so that a worker
   * losing races to other workers still finds somebody to handle.
   */
  async function candidates(slots: number): Promise<string[]> {
    const rows = await store.inbox.list({ status: "pending" }, { orderBy: "seq", limit: slots * 8 })

    const seen = new Set<string>()
    for (const row of rows) {
      if (active.has(row.person_id)) continue
      seen.add(row.person_id)
      if (seen.size >= slots * 2) break
    }
    return [...seen]
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

  /** One pass: find people, take as many as there are free slots for. */
  async function sweep(): Promise<void> {
    if (sweeping) {
      again = true
      return
    }
    sweeping = true

    try {
      do {
        again = false
        const slots = config.workerConcurrency - active.size
        if (slots <= 0) return

        for (const personId of await candidates(slots)) {
          if (active.size >= config.workerConcurrency) break
          if (active.has(personId)) continue
          if (!(await ready(personId))) continue

          const work = handle(personId)
            .catch(report)
            .finally(() => {
              active.delete(personId)
              // A person who finished frees a slot, and there may be more
              // waiting, so look again rather than wait for the poll.
              if (running) nudge()
            })
          active.set(personId, work)
        }
      } while (again)
    } catch (error) {
      report(error)
    } finally {
      sweeping = false
    }
  }

  function schedule(): void {
    if (!running) return
    timer = setTimeout(() => {
      void sweep().finally(schedule)
    }, config.workerPollMs)
  }

  function nudge(): void {
    if (!running) return
    void sweep()
  }

  return {
    get running() {
      return running
    },

    start(): void {
      if (running) return
      running = true
      // Look straight away, so a message already waiting is not held for
      // one poll interval before anything happens.
      void sweep()
      schedule()
    },

    async stop(): Promise<void> {
      running = false
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined

      // Turns in flight finish. Their leases are released as each one ends,
      // which is what hands the people straight back.
      while (active.size > 0) await Promise.all([...active.values()])
    },

    nudge,

    async drain(): Promise<void> {
      while (active.size > 0) await Promise.all([...active.values()])
    },

    busy: () => active.size,
  }
}
