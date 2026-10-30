// LEARN-3: the weekly digest.
//
// Every Monday at 09:00 in the agent's timezone, both defaults and both
// config, a message goes to the builder's channel: flag counts by kind
// against the week before, spend, median latency, and the five worst
// conversations by number of flags.
//
// Three decisions the builder made when this was built.
//
// **It keeps itself going two ways.** `start()` books the next one, and
// the handler books the one after it. Both use the same key, derived from
// the instant it is due, and PRO-1 makes the same key twice one job, so
// booking from both places is harmless. One path alone is not enough:
// rescheduling alone means a week that fails for good breaks the chain
// for ever and silently, and seeding alone means a process that runs for
// a month sends one digest.
//
// **A missed week goes out late, saying which week it is.** The window
// comes from the instant the job was *due*, carried in its payload, not
// from the clock when it runs. So an agent switched off over a Monday
// sends that Monday's digest when it comes back, covering the right seven
// days, with the dates at the top. The alternative was skipping it, which
// loses a week of numbers and says nothing.
//
// **No builder channel means no digest.** An agent whose builder does not
// want one is an ordinary agent, so this is not a refusal to start. It is
// said out loud instead, in `agent.notices`, because the bad outcome is
// mistyping the config and never learning why nothing arrived.
//
// It sends through the sender rather than the outbox, which needs a
// person row and the builder is not one. The delivery guarantee comes
// from the job instead: throwing means the job is retried with backoff
// like any other, and the digest is a report rather than a turn.
import type { OpenboxConfig } from "../config/index.ts"
import type { FlagKind, PersonRow, Store } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"
import { partsInZone } from "../time/index.ts"
import type { Jobs } from "./jobs.ts"
import type { Sender } from "./sender.ts"

/** LEARN-3's job kind. */
export const DIGEST_JOB = "weekly_digest"

/** How many conversations LEARN-3 asks for. */
export const WORST_CONVERSATIONS = 5

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Luxon's weekday numbering, which is 1 for Monday through 7 for Sunday. */
const WEEKDAY: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
}

/**
 * The next instant the agent's own clock reads the digest day at the
 * digest hour, strictly after `after`.
 *
 * Strictly, because the handler asks for the next one at the instant it
 * was due: were this inclusive it would book that same instant again and
 * the agent would send one digest for ever.
 */
export function nextDigestAt(after: Date, config: OpenboxConfig): Date {
  const { digestDay, digestHour } = config.learning
  const want = WEEKDAY[digestDay] ?? 1

  // Walked a day at a time in the agent's zone rather than computed with
  // arithmetic on the instant, because a week is not always 7 × 24 hours
  // where the clocks change, and the promise is about what the builder's
  // clock reads.
  for (let days = 0; days <= 8; days++) {
    const candidate = atHourInZone(after, days, digestHour, config.timezone)
    if (candidate.getTime() <= after.getTime()) continue
    if (weekdayInZone(candidate, config.timezone) === want) return candidate
  }
  // Unreachable: eight days always contain every weekday. Thrown rather
  // than returning a wrong instant, since a silently misplaced digest is
  // worse than a job that fails and says so.
  throw new Error(`could not find the next ${digestDay} after ${after.toISOString()}`)
}

/** `days` from `at`, at this hour exactly, read in the agent's timezone. */
function atHourInZone(at: Date, days: number, hour: number, timezone: string): Date {
  const { date } = partsInZone(new Date(at.getTime() + days * 24 * 60 * 60 * 1000), timezone)
  const clock = `${String(hour).padStart(2, "0")}:00`
  return new Date(instantOf(date, clock, timezone))
}

/**
 * The instant a wall clock reading names in a zone.
 *
 * Found by offset rather than with a date library's zone constructor, so
 * this file needs nothing luxon does not already give the time module:
 * read the guessed instant back in the zone, and correct by how far the
 * reading is out.
 */
function instantOf(date: string, time: string, timezone: string): number {
  let guess = Date.parse(`${date}T${time}:00Z`)
  for (let round = 0; round < 3; round++) {
    const parts = partsInZone(new Date(guess), timezone)
    const drift = Date.parse(`${parts.date}T${parts.time}:00Z`) - Date.parse(`${date}T${time}:00Z`)
    if (drift === 0) return guess
    guess -= drift
  }
  return guess
}

function weekdayInZone(at: Date, timezone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" })
    .format(at)
    .toLowerCase()
  return WEEKDAY[name] ?? 0
}

/** The seven days a digest covers, and the seven before them. */
export interface DigestWindow {
  /** Inclusive. */
  from: Date
  /** Exclusive, and the instant the digest was due. */
  to: Date
  /** Inclusive start of the week it compares against. */
  previousFrom: Date
}

/**
 * LEARN-3's two weeks, counted back from when the digest was due.
 *
 * From the due instant, not from now, so a digest that goes out late
 * still reports the week it was meant to.
 */
export function digestWindow(dueAt: Date): DigestWindow {
  return {
    to: dueAt,
    from: new Date(dueAt.getTime() - WEEK_MS),
    previousFrom: new Date(dueAt.getTime() - 2 * WEEK_MS),
  }
}

/** What one week looked like. */
export interface Digest {
  /** ISO, inclusive. */
  from: string
  /** ISO, exclusive. */
  to: string
  turns: number
  spendUsd: number
  /** Null when there were no turns to take a median of. */
  medianLatencyMs: number | null
  /** Only the kinds that happened, each with the week before for contrast. */
  flags: { kind: FlagKind; count: number; before: number }[]
  worst: { personId: string; name: string | null; channel: string; flags: number }[]
}

/** The middle value, or the mean of the middle two. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? null
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** LEARN-3's numbers, read for one window. */
export async function buildDigest(options: {
  store: Store
  window: DigestWindow
}): Promise<Digest> {
  const { store, window } = options
  const between = (from: Date, to: Date) => ({
    gte: { created_at: from.toISOString() },
    lt: { created_at: to.toISOString() },
  })

  const flags = await store.flags.list({}, { range: between(window.from, window.to) })
  const before = await store.flags.list({}, { range: between(window.previousFrom, window.from) })

  // Turns are read by when they started, which is the column they have.
  const turns = await store.turns.list(
    {},
    {
      range: {
        gte: { started_at: window.from.toISOString() },
        lt: { started_at: window.to.toISOString() },
      },
    },
  )

  const counted = new Map<FlagKind, number>()
  for (const flag of flags) counted.set(flag.kind, (counted.get(flag.kind) ?? 0) + 1)
  const countedBefore = new Map<FlagKind, number>()
  for (const flag of before) countedBefore.set(flag.kind, (countedBefore.get(flag.kind) ?? 0) + 1)

  const byPerson = new Map<string, number>()
  for (const flag of flags) byPerson.set(flag.person_id, (byPerson.get(flag.person_id) ?? 0) + 1)
  const top = [...byPerson.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, WORST_CONVERSATIONS)

  // One read per conversation, and there are at most five of them.
  const worst: Digest["worst"] = []
  for (const [personId, count] of top) {
    const person: PersonRow | null = await store.people.byId(personId)
    worst.push({
      personId,
      name: person?.display_name ?? null,
      channel: person?.channel ?? "unknown",
      flags: count,
    })
  }

  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    turns: turns.length,
    spendUsd: turns.reduce((total, turn) => total + (turn.cost_usd ?? 0), 0),
    medianLatencyMs: median(
      turns.flatMap((turn) => (turn.latency_ms === null ? [] : [turn.latency_ms])),
    ),
    flags: [...counted.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([kind, count]) => ({ kind, count, before: countedBefore.get(kind) ?? 0 })),
    worst,
  }
}

/** Which way a count moved, in a word a builder reads rather than a sign. */
function change(count: number, before: number): string {
  if (before === 0) return count === 0 ? "" : " (new)"
  const delta = count - before
  if (delta === 0) return ` (same as ${before})`
  return delta > 0 ? ` (up from ${before})` : ` (down from ${before})`
}

/** LEARN-3's message, as the builder reads it on their own channel. */
export function digestText(digest: Digest, timezone: string): string {
  const from = partsInZone(new Date(digest.from), timezone).date
  // The window ends at the instant the digest was due, so the last day it
  // covers is the day before that instant.
  const to = partsInZone(new Date(digest.to), timezone).date
  const lines = [`Weekly digest, ${from} to ${to}.`]

  // Nothing at all, which is not the same as no turns. A week can carry
  // flags without turns: an operator flagging a conversation by hand, or
  // a send blocked by a channel rule. Returning early on turns alone
  // printed "nothing happened" over the top of real flags, which the
  // integration test caught.
  if (digest.turns === 0 && digest.flags.length === 0) {
    lines.push("", "Nothing happened this week. No turns, no flags, nothing spent.")
    return lines.join("\n")
  }

  lines.push(
    "",
    `${digest.turns} turns, $${digest.spendUsd.toFixed(2)} spent.`,
    digest.medianLatencyMs === null
      ? "No latency recorded."
      : `Median latency ${digest.medianLatencyMs}ms.`,
  )

  lines.push("")
  if (digest.flags.length === 0) {
    lines.push("No flags at all this week.")
  } else {
    lines.push("Flags:")
    for (const flag of digest.flags) {
      lines.push(`  ${flag.kind}: ${flag.count}${change(flag.count, flag.before)}`)
    }
  }

  if (digest.worst.length > 0) {
    lines.push("", "Most flagged conversations:")
    for (const one of digest.worst) {
      const who = one.name ?? `${one.channel} ${one.personId.slice(0, 8)}`
      lines.push(`  ${who}: ${one.flags}`)
    }
  }

  return lines.join("\n")
}

export interface DigestOptions {
  config: OpenboxConfig
  store: Store
  clock: Clock
  jobs: Jobs
  sender: Sender
}

export interface Digests {
  /**
   * Books the next digest, if the builder wants one.
   *
   * `after` is what the next one is counted from, and it matters. At
   * startup it is now. After a digest is sent it is the instant that
   * digest was *due*, not the clock: counted from the clock, a digest
   * that ran on time would book the same Monday again, because that
   * Monday is still the next one the clock has not passed. Counted from
   * when it was due, a punctual run books the week after and a late run
   * books the week it still owes, which the loop then sends at once.
   *
   * Returns null when no `builderChannel` is set, which is what the
   * agent's notice is built from.
   */
  schedule(after?: Date): Promise<Date | null>
  /** The job handler. */
  run(job: { payload: Record<string, unknown> }): Promise<void>
}

/** The instant a digest is due, as its dedupe key (PRO-1). */
export const digestKey = (dueAt: Date): string => `${DIGEST_JOB}:${dueAt.toISOString()}`

export function createDigests(options: DigestOptions): Digests {
  const { config, store, clock, jobs, sender } = options

  async function schedule(after?: Date): Promise<Date | null> {
    if (config.builderChannel === undefined) return null
    const dueAt = nextDigestAt(after ?? clock.now(), config)
    await jobs.queue({
      kind: DIGEST_JOB,
      payload: { dueAt: dueAt.toISOString() },
      runAt: dueAt,
      dedupeKey: digestKey(dueAt),
    })
    return dueAt
  }

  return {
    schedule,

    async run(job): Promise<void> {
      const builder = config.builderChannel
      // Config can change between booking a digest and running it, and a
      // builder who has removed their channel has said they do not want
      // this. Not an error: there is simply nowhere to send it.
      if (builder === undefined) return

      // From the payload, so a digest that runs late covers the week it
      // was due for. Falling back to now would make a late digest quietly
      // report the wrong seven days.
      const due = job.payload["dueAt"]
      const dueAt = typeof due === "string" ? new Date(due) : clock.now()
      const window = digestWindow(dueAt)
      const digest = await buildDigest({ store, window })

      const result = await sender.send({
        channel: builder.channel,
        channelUserId: builder.channelUserId,
        text: digestText(digest, config.timezone),
        // The instant it was due, so a channel that honours the key
        // cannot deliver one week's digest twice however often the job is
        // retried or taken over.
        idempotencyKey: digestKey(dueAt),
      })

      // The next one is booked after the send, not before, so a send that
      // throws is retried as this same job rather than being skipped with
      // the chain carried on regardless.
      if (result.status === "rejected") {
        // Thrown, so the job loop retries it with backoff like any other
        // and the next digest is not booked over a failed one.
        throw new Error(`the digest could not be sent: ${result.error}`)
      }

      // No event of its own. EVT-2's table is the Spec's list and it has
      // no digest name in it, and nothing here needs one: the job loop
      // already records `job_ran` with this kind, and the job row keeps
      // the instant it was due beside the instant it actually ran, which
      // is how a late digest can be told from a punctual one. Adding
      // `digest_sent` would be a Spec change, so it waits to be asked for.
      // From when this one was due, not from now. See `schedule`.
      await schedule(dueAt)
    },
  }
}
