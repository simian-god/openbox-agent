// LOOP-11 and the Sender contract: getting a message out, or knowing why not.
//
// A reply the core has decided on is a fact; the channel being up is not.
// So the message is written down first and sent after. That is what lets a
// send be retried, be seen to have failed, or be left alone when its
// outcome is genuinely unknown.
//
// Three outcomes, from `Sender.send`:
//
//   sent                  -> done, with the channel's own message id
//   rejected, retryable   -> tried again later, up to `sendAttempts`
//   rejected, not         -> failed, recorded, never tried again
//   it threw              -> unknown. See below.
//
// `unknown` is the one worth understanding. A thrown send means the request
// went out and no answer came back, so the message may well have arrived.
// Sending it again would say it twice, and saying something twice to a
// customer is worse than not knowing whether it landed. So an unknown send
// stops there and is recorded, and only a channel that declares
// `idempotentSends` is tried again, because on such a channel a repeat
// cannot be seen by the person.
//
// Order matters as much as delivery: a person has to receive things in the
// order they were decided. The pump that drives this is keyed by person, so
// one person's messages go out one at a time, in `seq` order, while
// different people are served at once.
import type { OpenboxConfig } from "../config/index.ts"
import { isUniqueViolation, type OutboxKind, type OutboxRow, type Store } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"
import type { EventWriter } from "./events.ts"
import { createPump, type Pump } from "./pump.ts"
import type { Outbound, Sender } from "./sender.ts"

/** What a caller hands the outbox. The address, plus what to say. */
export interface Queued {
  personId: string
  turnId?: string | undefined
  kind: OutboxKind
  channel: string
  channelUserId: string
  text?: string | undefined
  buttons?: { label: string; payload: string }[] | undefined
  template?: { name: string; vars: Record<string, string> } | undefined
  file?: { url: string; name: string; mime: string } | undefined
  /** The same key twice is the same message, queued once. */
  idempotencyKey: string
  urgent?: boolean | undefined
  /** Not sent before this. Defaults to now. */
  notBefore?: Date | undefined
}

export interface OutboxOptions {
  config: OpenboxConfig
  store: Store
  clock: Clock
  sender: Sender
  events: EventWriter
  onError?: ((error: unknown) => void) | undefined
}

export interface Outbox {
  /** Writes a message down. Queuing the same key twice queues it once. */
  queue(message: Queued): Promise<OutboxRow>
  /** The pump that gets them out. */
  readonly pump: Pump
  /**
   * API-2: waits until every message from this turn has reached a final
   * state, which is `sent`, `failed` or `unknown`.
   */
  settle(turnId: string): Promise<OutboxRow[]>
  /** One row, start to finish. Exposed so a test can drive it directly. */
  attempt(row: OutboxRow): Promise<OutboxRow>
}

const FINAL = new Set(["sent", "failed", "unknown"])

/** The payload a row carries, as an `Outbound` the sender understands. */
export function toOutbound(row: OutboxRow): Outbound {
  const payload = row.payload as {
    text?: string
    buttons?: { label: string; payload: string }[]
    template?: { name: string; vars: Record<string, string> }
    file?: { url: string; name: string; mime: string }
  }

  return {
    channel: row.channel,
    channelUserId: row.channel_user_id,
    ...(payload.text !== undefined ? { text: payload.text } : {}),
    ...(payload.buttons !== undefined ? { buttons: payload.buttons } : {}),
    ...(payload.template !== undefined ? { template: payload.template } : {}),
    ...(payload.file !== undefined ? { file: payload.file } : {}),
    idempotencyKey: row.idempotency_key,
  }
}

/**
 * How long to wait before attempt number `attempts + 1`.
 *
 * Doubling, with a little jitter so that a thousand messages queued by one
 * outage do not all come back at the same instant and cause the next one.
 */
export function backoffMs(attempts: number, base: number): number {
  const doubled = base * 2 ** Math.max(0, attempts - 1)
  return Math.round(doubled * (0.85 + Math.random() * 0.3))
}

/**
 * The longest the whole retry schedule can take, with slack.
 *
 * What `settle` is allowed to wait for, so a caller never hangs on a
 * message that is not coming.
 */
export function budgetMs(attempts: number, base: number): number {
  let total = 0
  for (let n = 1; n < attempts; n++) total += base * 2 ** (n - 1)
  return Math.round(total * 1.3) + 5_000
}

export function createOutbox(options: OutboxOptions): Outbox {
  const { config, store, clock, sender, events, onError } = options

  const report = (error: unknown): void => {
    try {
      onError?.(error)
    } catch {
      // A broken handler must not stop messages going out.
    }
  }

  async function queue(message: Queued): Promise<OutboxRow> {
    const payload = {
      ...(message.text !== undefined ? { text: message.text } : {}),
      ...(message.buttons !== undefined ? { buttons: message.buttons } : {}),
      ...(message.template !== undefined ? { template: message.template } : {}),
      ...(message.file !== undefined ? { file: message.file } : {}),
    }

    try {
      const row = await store.outbox.insert({
        person_id: message.personId,
        ...(message.turnId !== undefined ? { turn_id: message.turnId } : {}),
        kind: message.kind,
        channel: message.channel,
        channel_user_id: message.channelUserId,
        payload,
        idempotency_key: message.idempotencyKey,
        urgent: message.urgent ?? false,
        not_before: (message.notBefore ?? clock.now()).toISOString(),
      })
      pump.nudge()
      return row
    } catch (error) {
      // The same key again is the same message. Whoever queued it first
      // decided what it says, and that is what goes out.
      if (!isUniqueViolation(error)) throw error
      const existing = await store.outbox.find({ idempotency_key: message.idempotencyKey })
      if (existing === null) throw error
      return existing
    }
  }

  /** DATA-4: takes one row, or returns null because somebody else did. */
  async function claim(id: string): Promise<OutboxRow | null> {
    const rows = await store.outbox.update(
      { id, status: "queued" },
      { status: "sending", last_attempt_at: clock.now().toISOString() },
      { lte: { not_before: clock.now().toISOString() } },
    )
    return rows[0] ?? null
  }

  async function finish(row: OutboxRow, patch: Record<string, unknown>): Promise<OutboxRow> {
    const rows = await store.outbox.update({ id: row.id }, patch)
    return rows[0] ?? { ...row, ...patch }
  }

  async function attempt(row: OutboxRow): Promise<OutboxRow> {
    const attempts = row.attempts + 1
    const last = attempts >= config.sendAttempts

    let result: Awaited<ReturnType<Sender["send"]>>
    try {
      result = await sender.send(toOutbound(row))
    } catch (error) {
      // The outcome is unknown, not failed. It may have arrived.
      const message = error instanceof Error ? error.message : String(error)
      const idempotent = sender.capabilities(row.channel).idempotentSends

      await events.about({ personId: row.person_id, ...turnOf(row) }).record("send_unknown", {
        outboxId: row.id,
        kind: row.kind,
        attempts,
        error: message,
        // Said plainly in the trace, because this is the decision someone
        // reading it will want to understand.
        retrying: idempotent && !last,
      })

      if (idempotent && !last) {
        return finish(row, {
          status: "queued",
          attempts,
          error: message,
          not_before: new Date(
            clock.now().getTime() + backoffMs(attempts, config.sendBackoffMs),
          ).toISOString(),
        })
      }
      return finish(row, { status: "unknown", attempts, error: message })
    }

    if (result.status === "sent") {
      return finish(row, {
        status: "sent",
        attempts,
        channel_message_id: result.channelMessageId,
        error: null,
      })
    }

    if (!result.retryable || last) {
      await events.about({ personId: row.person_id, ...turnOf(row) }).record("send_failed", {
        outboxId: row.id,
        kind: row.kind,
        attempts,
        error: result.error,
        retryable: result.retryable,
      })
      return finish(row, { status: "failed", attempts, error: result.error })
    }

    return finish(row, {
      status: "queued",
      attempts,
      error: result.error,
      not_before: new Date(
        clock.now().getTime() + backoffMs(attempts, config.sendBackoffMs),
      ).toISOString(),
    })
  }

  const turnOf = (row: OutboxRow) => (row.turn_id !== null ? { turnId: row.turn_id } : {})

  /** What is due, oldest first, bounded both ways. */
  async function candidates(slots: number): Promise<OutboxRow[]> {
    const rows = await store.outbox.list({ status: "queued" }, { orderBy: "seq", limit: slots * 8 })
    const now = clock.now().getTime()
    const due = rows.filter((row) => new Date(row.not_before).getTime() <= now)

    // One per person per pass: the pump is keyed by person, so taking two
    // of somebody's messages at once is the one thing that could put them
    // out of order.
    const seen = new Set<string>()
    const out: OutboxRow[] = []
    for (const row of due) {
      if (seen.has(row.person_id)) continue
      seen.add(row.person_id)
      out.push(row)
      if (out.length >= slots * 2) break
    }
    return out
  }

  const pump = createPump<OutboxRow>({
    pollMs: config.workerPollMs,
    concurrency: config.workerConcurrency,
    candidates,
    // Keyed by person, so one person's messages go out one at a time.
    key: (row) => row.person_id,
    handle: async (row) => {
      const taken = await claim(row.id)
      if (taken === null) return
      await attempt(taken)
    },
    ...(onError !== undefined ? { onError } : {}),
  })

  return {
    queue,
    pump,
    attempt,

    async settle(turnId: string): Promise<OutboxRow[]> {
      // Bounded by what the retry policy can take, plus slack. Without a
      // bound this waits for ever on a message something else has put off,
      // which is what PRO-3's quiet hours will do, and a caller of
      // `receiveAndWait` must not hang because of that.
      const budget = budgetMs(config.sendAttempts, config.sendBackoffMs)
      const until = clock.now().getTime() + budget

      for (;;) {
        const rows = await store.outbox.list({ turn_id: turnId }, { orderBy: "seq" })
        if (rows.every((row) => FINAL.has(row.status))) return rows
        // Shutting down, so nothing more is going to happen here.
        if (!pump.running) return rows
        if (clock.now().getTime() >= until) return rows

        // These rows are this process's to send in the normal case, so the
        // nudge moves them along rather than the poll interval.
        pump.nudge()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}
