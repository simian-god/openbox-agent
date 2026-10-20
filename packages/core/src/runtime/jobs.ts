// DATA-4 and PRO-1: the job loop, and the recovery sweep.
//
// A job is anything the agent does at a time rather than in answer to a
// message. None of those features exist yet. What exists is the loop that
// will run them, and the first thing worth running.
//
// The recovery sweep is that thing. A process killed in the middle of a
// turn leaves the messages it had taken marked `merged`, and nothing looks
// for those: another worker takes the person over once the lease expires,
// but it only looks for messages still `pending`. Without this, those
// messages are the one way a message can be lost outright.
//
// It is not a job row. Who would create the first one, and who would
// reschedule it, are questions with no good answer at this size, so it
// runs on the loop's own cadence the way the outbox's retries run on
// the outbox pump's.
import type { OpenboxConfig } from "../config/index.ts"
import { isUniqueViolation, type JobRow, type Store } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"
import type { EventWriter } from "./events.ts"
import { backoffMs } from "./outbox.ts"
import { createPump, type Pump } from "./pump.ts"

/** What a caller hands the job loop. */
export interface JobRequest {
  kind: string
  payload?: Record<string, unknown> | undefined
  /** When it may run. Defaults to now. */
  runAt?: Date | undefined
  /** PRO-1: the same key twice is the same job, queued once. */
  dedupeKey?: string | undefined
}

/** What runs a job. Throwing means it failed and may be tried again. */
export type JobHandler = (job: JobRow) => Promise<void>

export interface JobsOptions {
  config: OpenboxConfig
  store: Store
  clock: Clock
  events: EventWriter
  /** Which process this is, recorded on the jobs it claims. */
  owner: string
  /** One per kind. A job of an unregistered kind fails loudly. */
  handlers?: Record<string, JobHandler> | undefined
  onError?: ((error: unknown) => void) | undefined
}

export interface Jobs {
  /** Writes a job down. The same dedupe key twice queues it once. */
  queue(job: JobRequest): Promise<JobRow>
  readonly pump: Pump
  /** One job, start to finish. Exposed so a test can drive it directly. */
  run(job: JobRow): Promise<JobRow>
  /**
   * Hands back the messages a dead process took and never finished with.
   *
   * Returns how many it reset. Runs on every pass of the loop, because it
   * is two bounded indexed reads and the cost of missing one is a person
   * who never gets an answer.
   */
  recover(): Promise<number>
  /** Registers a handler after construction, which the agent needs. */
  on(kind: string, handler: JobHandler): void
}

export function createJobs(options: JobsOptions): Jobs {
  const { config, store, clock, events, owner, onError } = options
  const handlers: Record<string, JobHandler> = { ...options.handlers }

  const report = (error: unknown): void => {
    try {
      onError?.(error)
    } catch {
      // A broken handler must not stop the loop.
    }
  }

  const leaseUntil = (): string =>
    new Date(clock.now().getTime() + config.leaseSeconds * 1000).toISOString()

  async function queue(job: JobRequest): Promise<JobRow> {
    try {
      const row = await store.jobs.insert({
        kind: job.kind,
        payload: job.payload ?? {},
        run_at: (job.runAt ?? clock.now()).toISOString(),
        ...(job.dedupeKey !== undefined ? { dedupe_key: job.dedupeKey } : {}),
      })
      pump.nudge()
      return row
    } catch (error) {
      // PRO-1: scheduling the same thing twice is a no op, decided by the
      // unique key rather than by a prior read.
      if (!isUniqueViolation(error) || job.dedupeKey === undefined) throw error
      const existing = await store.jobs.find({ dedupe_key: job.dedupeKey })
      if (existing === null) throw error
      return existing
    }
  }

  /** DATA-4: takes a job that is due, or returns null because someone did. */
  async function claim(id: string): Promise<JobRow | null> {
    const now = clock.now().toISOString()
    const rows = await store.jobs.update(
      { id, status: "queued" },
      { status: "running", lease_owner: owner, lease_expires_at: leaseUntil(), last_run_at: now },
      { lte: { run_at: now } },
    )
    return rows[0] ?? null
  }

  /**
   * DATA-4 again: takes a job another process claimed and never finished.
   *
   * Two conditional updates rather than one with an OR, because `Where`
   * has no OR and a claim that needs one is a claim nobody can read.
   */
  async function reclaim(id: string): Promise<JobRow | null> {
    const now = clock.now().toISOString()
    const rows = await store.jobs.update(
      { id, status: "running" },
      { lease_owner: owner, lease_expires_at: leaseUntil(), last_run_at: now },
      { lt: { lease_expires_at: now } },
    )
    return rows[0] ?? null
  }

  async function run(job: JobRow): Promise<JobRow> {
    const attempts = job.attempts + 1
    const handler = handlers[job.kind]

    const finish = async (patch: Record<string, unknown>): Promise<JobRow> => {
      const rows = await store.jobs.update({ id: job.id }, patch)
      return rows[0] ?? { ...job, ...patch }
    }

    if (handler === undefined) {
      // Not retried: nothing about waiting will make the handler appear.
      const error = `no handler is registered for job kind ${job.kind}`
      await events.record("job_ran", { job: job.kind, ok: false, attempts, error })
      return finish({ status: "failed", attempts, error, lease_owner: null })
    }

    try {
      await handler(job)
      await events.record("job_ran", { job: job.kind, ok: true, attempts })
      return finish({ status: "done", attempts, error: null, lease_owner: null })
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught)
      const last = attempts >= config.jobAttempts
      await events.record("job_ran", {
        job: job.kind,
        ok: false,
        attempts,
        error,
        retrying: !last,
      })

      if (last) return finish({ status: "failed", attempts, error, lease_owner: null })
      return finish({
        status: "queued",
        attempts,
        error,
        lease_owner: null,
        lease_expires_at: null,
        run_at: new Date(
          clock.now().getTime() + backoffMs(attempts, config.jobBackoffMs),
        ).toISOString(),
      })
    }
  }

  async function recover(): Promise<number> {
    // Messages a turn took and never finished with. Bounded and indexed.
    const stuck = await store.inbox.list({ status: "merged" }, { orderBy: "seq", limit: 200 })
    if (stuck.length === 0) return 0

    // Only for people nobody is handling any more. The lease expiring
    // already means renewal stopped for a whole lease; the margin on top
    // is for a process that was stalled rather than dead, because taking
    // the messages back from one that is still going would answer the
    // person twice.
    const cutoff = new Date(clock.now().getTime() - config.recoverAfterSeconds * 1000).toISOString()

    const byPerson = new Map<string, string[]>()
    for (const row of stuck) {
      byPerson.set(row.person_id, [...(byPerson.get(row.person_id) ?? []), row.id])
    }

    let reset = 0
    for (const [personId, ids] of byPerson) {
      const lease = await store.leases.find({ person_id: personId })
      if (lease === null) continue
      if (lease.expires_at > cutoff) continue

      const rows = await store.inbox.update(
        { person_id: personId, status: "merged" },
        { status: "pending" },
        { isIn: { id: ids } },
      )
      reset += rows.length

      if (rows.length > 0) {
        await events.about({ personId }).record("job_ran", {
          job: "recover_turns",
          ok: true,
          attempts: 1,
          messages: rows.length,
          // Said plainly, because somebody reading the trace will want to
          // know a turn was abandoned rather than merely slow.
          why: "a turn was abandoned by a process that stopped",
        })
      }
    }
    return reset
  }

  /** What is due, oldest first, plus anything abandoned. */
  async function candidates(slots: number): Promise<JobRow[]> {
    const now = clock.now().getTime()

    const queued = await store.jobs.list(
      { status: "queued" },
      { orderBy: "run_at", limit: slots * 8 },
    )
    const due = queued.filter((job) => new Date(job.run_at).getTime() <= now)

    const running = await store.jobs.list(
      { status: "running" },
      { orderBy: "run_at", limit: slots },
    )
    const abandoned = running.filter(
      (job) => job.lease_expires_at !== null && new Date(job.lease_expires_at).getTime() < now,
    )

    return [...due, ...abandoned].slice(0, slots * 2)
  }

  const pump = createPump<JobRow>({
    pollMs: config.workerPollMs,
    concurrency: config.workerConcurrency,
    candidates: async (slots) => {
      // The sweep rides on the loop's cadence rather than being a job of
      // its own, so there is nothing to bootstrap and nothing to
      // reschedule.
      await recover().catch(report)
      return candidates(slots)
    },
    key: (job) => job.id,
    handle: async (job) => {
      const taken = job.status === "running" ? await reclaim(job.id) : await claim(job.id)
      if (taken === null) return
      await run(taken)
    },
    ...(onError !== undefined ? { onError } : {}),
  })

  return {
    queue,
    pump,
    run,
    recover,
    on(kind: string, handler: JobHandler): void {
      handlers[kind] = handler
    },
  }
}
