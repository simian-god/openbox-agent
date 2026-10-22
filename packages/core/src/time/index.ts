// TIME-1 to TIME-4: the time helpers a tool gets in `ctx.time`.
//
// The rule this file exists to keep is that date arithmetic never happens
// in a model. The M1 live run is why: the demo tool took a raw date, the
// brain worked out which day Friday was, got it wrong, and told someone
// Sunday's opening hours. The tool now takes the words the person said and
// resolves them here, in code, against an injected clock.
//
// Two things about the libraries turned out to matter, and both were found
// by running them rather than by reading about them.
//
// chrono resolves a phrase against the *process's* local timezone, not the
// agent's. "in 2 hours" against the same instant gives a different answer
// on a server in UTC than on a laptop in India. So chrono is used purely
// as a phrase to components parser: it is given a reference expressed as
// the agent's wall clock, and only `get`/`isCertain` are read from the
// result. `result.date()` is never called, because that is the call that
// would quietly reintroduce the server's zone.
//
// And chrono will happily match part of a phrase and ignore the rest. "the
// 31st at 9" comes back as "at 9" on today's date, with no sign anything
// was dropped except the `text` field. A confident wrong date is the worst
// answer this file could give, so a leftover that still looks like a date
// makes the whole phrase ambiguous.
import * as chrono from "chrono-node"
import { DateTime } from "luxon"
import type { OpenboxConfig } from "../config/index.ts"
import type { Clock } from "../testing/clock.ts"

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
export type DayKey = (typeof DAY_KEYS)[number]

/** One thing a phrase could have meant. */
export interface Candidate {
  at: Date
  /** The same instant, written out in the agent's timezone. */
  text: string
}

/**
 * TIME-2: what `resolve` answers.
 *
 * `ambiguous` is not a failure, it is the answer. TIME-3 says an ambiguous
 * phrase goes back to the brain so it can ask the person, and a tool that
 * guessed instead would be making exactly the mistake this file prevents.
 */
export type TimeResolution =
  | { kind: "exact"; at: Date; text: string }
  | { kind: "ambiguous"; why: string; candidates: Candidate[] }

export interface TimeHelpers {
  /** TIME-2: "tomorrow 8pm" to an instant, or ambiguous with candidates. */
  resolve(phrase: string): TimeResolution
  /** TIME-2: whether the agent is open at that instant, from config.hours. */
  isOpen(at: Date): boolean
  /** TIME-2: the next instant it opens after this one, or null within a week. */
  nextOpen(after: Date): Date | null
  /** TIME-2: how a time is written back to the person. */
  format(at: Date): string
  /** The opening ranges for the day an instant falls on, after exceptions. */
  rangesOn(at: Date): [string, string][]
}

/** The parts of a date, read in the agent's timezone rather than the server's. */
export function partsInZone(at: Date, timezone: string) {
  const zoned = DateTime.fromJSDate(at, { zone: timezone })
  return {
    weekday: zoned.toFormat("cccc"),
    date: zoned.toFormat("yyyy-MM-dd"),
    time: zoned.toFormat("HH:mm"),
  }
}

/** Which day of the week an instant falls on, in the agent's timezone. */
export function dayKeyInZone(at: Date, timezone: string): DayKey {
  // Luxon's weekday is 1 for Monday through 7 for Sunday.
  const weekday = DateTime.fromJSDate(at, { zone: timezone }).weekday
  return DAY_KEYS[weekday % 7] as DayKey
}

/** TIME-2: the opening ranges for a day, with exceptions applied. */
export function rangesOn(config: OpenboxConfig, at: Date): [string, string][] {
  const { date } = partsInZone(at, config.timezone)
  const exception = config.hours.exceptions?.find((entry) => entry.date === date)

  if (exception?.closed === true) return []
  if (exception?.ranges !== undefined) return exception.ranges as [string, string][]

  return (config.hours[dayKeyInZone(at, config.timezone)] ?? []) as [string, string][]
}

/** The opening hours for one day, as a line a brain can read. */
export function hoursLine(config: OpenboxConfig, at: Date): string {
  const ranges = rangesOn(config, at)
  if (ranges.length === 0) return "closed"
  return ranges.map(([from, to]) => `${from} to ${to}`).join(", ")
}

const minutesOf = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

/** Words that mean a leftover was part of the date, not filler. */
const STILL_A_DATE =
  /\d|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|today|tomorrow|tonight|next|last|week|month|morning|noon|afternoon|evening|night/i

export interface TimeOptions {
  config: OpenboxConfig
  clock: Clock
}

export function createTimeHelpers(options: TimeOptions): TimeHelpers {
  const { config, clock } = options
  const zone = config.timezone

  const write = (at: Date): string => {
    const zoned = DateTime.fromJSDate(at, { zone })
    const thisYear = DateTime.fromJSDate(clock.now(), { zone }).year
    return zoned.year === thisYear
      ? zoned.toFormat("cccc d LLLL 'at' HH:mm")
      : zoned.toFormat("cccc d LLLL yyyy 'at' HH:mm")
  }

  /** The components of a chrono result, as an instant in the agent's zone. */
  const toInstant = (start: chrono.ParsedComponents): Date | null => {
    const built = DateTime.fromObject(
      {
        year: start.get("year") ?? undefined,
        month: start.get("month") ?? undefined,
        day: start.get("day") ?? undefined,
        hour: start.get("hour") ?? 0,
        minute: start.get("minute") ?? 0,
        second: 0,
      },
      { zone },
    )
    // A local time that does not exist, on the hour a zone springs forward,
    // comes back shifted rather than invalid. Worth knowing; nothing here
    // can do better than take the shifted instant.
    return built.isValid ? built.toJSDate() : null
  }

  return {
    rangesOn: (at: Date) => rangesOn(config, at),

    format: write,

    resolve(phrase: string): TimeResolution {
      const asked = phrase.trim()
      if (asked === "") {
        return { kind: "ambiguous", why: "no time was given", candidates: [] }
      }

      // The reference chrono parses against, expressed as the agent's wall
      // clock rather than as an instant. This is the line that keeps the
      // server's timezone out of the answer.
      const nowHere = DateTime.fromJSDate(clock.now(), { zone })
      const reference = new Date(
        nowHere.year,
        nowHere.month - 1,
        nowHere.day,
        nowHere.hour,
        nowHere.minute,
        0,
      )

      const results = chrono.parse(asked, reference, { forwardDate: true })

      if (results.length === 0) {
        return {
          kind: "ambiguous",
          why: `"${asked}" is not a date or time I can read. Ask the person for a day and a time.`,
          candidates: [],
        }
      }

      if (results.length > 1) {
        const candidates = results
          .map((result) => toInstant(result.start))
          .filter((at): at is Date => at !== null)
          .map((at) => ({ at, text: write(at) }))
        return {
          kind: "ambiguous",
          why: `"${asked}" names more than one time. Ask the person which they mean.`,
          candidates,
        }
      }

      const result = results[0] as chrono.ParsedResult
      const start = result.start

      // chrono will match part of a phrase and drop the rest. If what it
      // ignored still looks like a date, the answer it gave is about the
      // wrong day and nothing else here would notice.
      const leftover = `${asked.slice(0, result.index)} ${asked.slice(
        result.index + result.text.length,
      )}`
      if (STILL_A_DATE.test(leftover)) {
        return {
          kind: "ambiguous",
          why: `I could only read "${result.text}" out of "${asked}", and the rest looks like part of the date. Ask the person to say the day and time plainly.`,
          candidates: [],
        }
      }

      const at = toInstant(start)
      if (at === null) {
        return {
          kind: "ambiguous",
          why: `"${asked}" is not a time that exists. Ask the person for another.`,
          candidates: [],
        }
      }

      // TIME-3: a phrase with no time of day is not a time. "Friday" is a
      // day, and booking it at noon because chrono defaults there is the
      // kind of guess that loses a table.
      if (!start.isCertain("hour")) {
        const day = DateTime.fromJSDate(at, { zone }).toFormat("cccc d LLLL")
        return {
          kind: "ambiguous",
          why: `"${asked}" gives a day but no time of day. Ask the person what time on ${day}.`,
          candidates: [],
        }
      }

      // "next friday" is genuinely ambiguous in English: the Friday coming
      // or the one after it. A bare "friday" is not, and treating it as
      // ambiguous would have the agent asking "which Friday?" every time
      // somebody named a day.
      //
      // What makes a bare weekday safe to act on is not certainty, it is
      // that the answer is read back. The tool returns `format(at)`, so
      // the person sees "Friday 23 October at 20:00" and can correct it,
      // and anything irreversible shows the same date in its confirm
      // summary before it happens (CONF-1).
      if (/\bnext\b/i.test(result.text)) {
        // The parser reads "next friday" as the Friday after the coming
        // one, which is one of the two things people mean by it. The other
        // is the coming Friday, a week earlier, and only if that has not
        // already gone past.
        const earlier = DateTime.fromJSDate(at, { zone }).minus({ weeks: 1 }).toJSDate()
        if (earlier.getTime() > clock.now().getTime()) {
          return {
            kind: "ambiguous",
            why: `"${asked}" could be the one coming or the one after. Ask the person which.`,
            candidates: [
              { at: earlier, text: write(earlier) },
              { at, text: write(at) },
            ],
          }
        }
        // The coming one has gone, so there is only one reading left and
        // it is not ambiguous after all.
      }

      return { kind: "exact", at, text: write(at) }
    },

    isOpen(at: Date): boolean {
      const ranges = rangesOn(config, at)
      if (ranges.length === 0) return false

      const { time } = partsInZone(at, zone)
      const minute = minutesOf(time)
      // The closing time is the moment it closes, so 23:00 is shut.
      return ranges.some(([from, to]) => minute >= minutesOf(from) && minute < minutesOf(to))
    },

    nextOpen(after: Date): Date | null {
      const from = DateTime.fromJSDate(after, { zone })

      // A week of days, which is as far as a weekly pattern can hide an
      // opening. Beyond that it is closed for the week and saying so is
      // more use than a date a month out.
      for (let ahead = 0; ahead <= 7; ahead++) {
        const day = from.plus({ days: ahead })
        for (const [open] of rangesOn(config, day.toJSDate())) {
          const at = day.set({
            hour: Number(open.slice(0, 2)),
            minute: Number(open.slice(3, 5)),
            second: 0,
            millisecond: 0,
          })
          if (at.toMillis() > after.getTime()) return at.toJSDate()
        }
      }
      return null
    },
  }
}
