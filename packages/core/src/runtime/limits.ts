// LIMIT-1 to LIMIT-3: the three things that stop a turn whatever it was
// going to say.
//
// They are not alike. The rate limit protects the agent from one person,
// the spend cap protects the builder from the agent, and the step cap
// protects the person from a loop. What they share is that the person is
// told something fixed and short, and a colleague is told as well, because
// each of these is the agent saying "not now" and somebody has to know.
//
// Two things here are worth reading closely.
//
// The spend total is a row, not a sum. The core reads the database through
// PostgREST and DATA-3 rules out stored functions, so there is no SUM: a
// total added up from the day's turns grows with traffic, has to be capped,
// and then stops counting on exactly the day it matters. So each turn adds
// what it cost to one row per day, with the same conditional claim the rest
// of the core uses (DATA-4), versioned by `calls` because an integer
// compares exactly and a running float does not.
//
// And a cost is only sometimes the provider's. LIMIT-3 says to use the
// reported cost when there is one and the config's pricing table otherwise,
// so `costOf` is the one place that decides, and every caller goes through
// it rather than reading `usage.costUsd` and shrugging at undefined.
import type { OpenboxConfig } from "../config/index.ts"
import { isUniqueViolation, type PersonRow, type Store } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"
import { partsInZone } from "../time/index.ts"

/**
 * LIMIT-1: what somebody gets when they are over the limit, once.
 *
 * It says what happened and what to do, because a person who is sending
 * that much usually believes nothing is arriving.
 */
export const RATE_LIMIT_REPLY =
  "We have had a lot of messages from you in the last few minutes, so this one has not been answered. Please give us a little while and send one message with what you need."

/** LOOP-9: the step cap. The Spec's own words. */
export const STEP_CAP_REPLY = "Let me check on that and come back to you."

/** LOOP-12: every brain failed. */
export const BRAINS_FAILED_REPLY =
  "Sorry, something went wrong at our end and I could not answer that. Someone will get back to you here shortly."

/** What a call reported about itself, in the shape both providers share. */
export interface CallUsage {
  inputTokens: number
  outputTokens?: number | undefined
  costUsd?: number | undefined
}

/**
 * LIMIT-3: what one call cost, in USD.
 *
 * The provider's own number when it sent one, because it is the only one
 * that can account for caching, discounts and a mid month price change.
 * Otherwise the config's pricing table, by model id. A model the table
 * does not list costs zero, which is a known undercount rather than a
 * guess: inventing a price would make the cap fire on a number nobody
 * can check.
 */
export function costOf(config: OpenboxConfig, model: string, usage: CallUsage): number {
  if (usage.costUsd !== undefined) return usage.costUsd

  const price = config.pricing[model]
  if (price === undefined) return 0

  const input = (usage.inputTokens / 1_000_000) * price.inputPerM
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * price.outputPerM
  return input + output
}

/** LIMIT-1: where this person stands in the current window. */
export type RateVerdict =
  /** Under the limit. The turn goes on. */
  | "under"
  /** Over it, and nobody has told them yet this window. */
  | "over"
  /** Over it, and they have already been told. Silence (LIMIT-1). */
  | "silent"

export interface Limits {
  /** LIMIT-1: this person's standing, from their own messages. */
  rate(person: PersonRow): Promise<RateVerdict>
  /** LIMIT-3: today's total, and whether it has reached the cap. */
  spent(): Promise<{ usd: number; over: boolean }>
  /**
   * LIMIT-3: adds what a call cost to today's total.
   *
   * Returns the new total, or null when the claim could not be won after
   * several tries, which the caller reports rather than failing a turn
   * that has already answered somebody.
   */
  add(usd: number): Promise<number | null>
  /** The day today's total is counted under, in the agent's timezone. */
  today(): string
}

export interface LimitsOptions {
  config: OpenboxConfig
  store: Store
  clock: Clock
}

/** How many times a contended increment is retried before giving up. */
const CLAIM_TRIES = 20

/**
 * A short, uneven wait between two attempts at the same row.
 *
 * Twenty turns ending at once all read the same row and all but one lose
 * the claim. Without a pause they would retry in step and keep losing in
 * step; with an uneven one they spread out and each gets its turn. Real
 * time rather than the injected clock, because this is about what other
 * processes are doing, not about what the agent thinks the time is.
 */
const breathe = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 1 + Math.floor(Math.random() * 8)))

export function createLimits(options: LimitsOptions): Limits {
  const { config, store, clock } = options

  const today = (): string => partsInZone(clock.now(), config.timezone).date

  async function spent(): Promise<{ usd: number; over: boolean }> {
    const row = await store.spend.find({ day: today() })
    const usd = row === null ? 0 : Number(row.usd)
    return { usd, over: usd >= config.limits.dailySpendUsd }
  }

  return {
    today,
    spent,

    async rate(person: PersonRow): Promise<RateVerdict> {
      const { messagesPerWindow, windowMinutes } = config.limits
      const cutoff = clock.now().getTime() - windowMinutes * 60_000

      // Bounded on purpose: one more row than the limit answers the
      // question "are there more than this many in the window", and no
      // read here grows with how much somebody has ever sent.
      const recent = await store.inbox.list(
        { person_id: person.id },
        { orderBy: "seq", ascending: false, limit: messagesPerWindow + 1 },
      )
      const inWindow = recent.filter((row) => new Date(row.received_at).getTime() >= cutoff)
      if (inWindow.length <= messagesPerWindow) return "under"

      // LIMIT-1: one fixed reply per window, then silence. What decides is
      // whether this person has already been told in this window, which
      // the trace already records. A handful of rows, because the spend
      // cap writes `limit_hit` too and the newest one may be that.
      const told = await store.events.list(
        { person_id: person.id, name: "limit_hit" },
        { orderBy: "seq", ascending: false, limit: 5 },
      )
      const already = told.some(
        (row) =>
          (row.props as { limit?: unknown }).limit === "rate" &&
          new Date(row.created_at).getTime() >= cutoff,
      )
      return already ? "silent" : "over"
    },

    async add(usd: number): Promise<number | null> {
      if (usd <= 0) {
        const { usd: current } = await spent()
        return current
      }

      const day = today()
      for (let tries = 0; tries < CLAIM_TRIES; tries++) {
        const row = await store.spend.find({ day })

        if (row === null) {
          try {
            const made = await store.spend.insert({
              day,
              usd,
              calls: 1,
              updated_at: clock.now().toISOString(),
            })
            return Number(made.usd)
          } catch (error) {
            // Another process wrote the day's first row. Read it and add.
            if (!isUniqueViolation(error)) throw error
            continue
          }
        }

        // DATA-4: the expected state is the row's own call count, which
        // is an integer and compares exactly. A float total would not.
        const next = Number(row.usd) + usd
        const [won] = await store.spend.update(
          { id: row.id, calls: row.calls },
          { usd: next, calls: row.calls + 1, updated_at: clock.now().toISOString() },
        )
        if (won !== undefined) return Number(won.usd)
        await breathe()
      }

      return null
    },
  }
}
