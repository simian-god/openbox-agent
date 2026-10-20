// The demo agent's one tool.
//
// It answers from the config's opening hours rather than from the prompt,
// which is the point: a date is a fact a tool looks up, never something a
// brain works out. The time helpers in `ctx.time` arrive in M4, so this
// does its own small lookup from the config.
//
// The input is a closed list on purpose. An earlier version also took a
// date like 2026-10-23, and a model asked about Sunday worked the date out
// itself, got Friday, and reported Friday's hours as Sunday's. prompt.md
// forbade exactly that and the model did it anyway. A tool that cannot be
// handed a date cannot be handed a wrong one, so the day arithmetic lives
// here. The cost is that only this coming week can be asked about, which
// is what a weekday name can mean.
import { defineTool, partsInZone } from "openbox-agent"
import { z } from "zod"
import config from "../agent.config.ts"

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
type Day = (typeof DAYS)[number]

/** Every day the tool can be asked about. Nothing else parses. */
export const ASKABLE = [
  "today",
  "tomorrow",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const

/** The date the brain asked about, as a calendar date in the agent's zone. */
export function resolveDate(asked: (typeof ASKABLE)[number], now: Date): string {
  const at = (ahead: number) =>
    partsInZone(new Date(now.getTime() + ahead * 86_400_000), config.timezone).date

  if (asked === "today") return at(0)
  if (asked === "tomorrow") return at(1)

  // A weekday means the next time that day comes round, today included.
  const wanted = asked.slice(0, 3) as Day
  for (let ahead = 0; ahead < 7; ahead++) {
    if (dayOf(new Date(now.getTime() + ahead * 86_400_000)) === wanted) return at(ahead)
  }
  // Unreachable: seven days always contain every weekday.
  return at(0)
}

function dayOf(at: Date): Day {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    weekday: "short",
  })
    .format(at)
    .toLowerCase()
  return (DAYS.find((day) => day === short) ?? "mon") as Day
}

export default defineTool({
  name: "check_opening_hours",
  description: "Looks up the restaurant's opening hours for one day, holidays included.",

  input: z.object({
    day: z
      .enum(ASKABLE)
      .describe(
        'which day to look up. Say "today", "tomorrow", or the weekday the person means. Never work out a date yourself: pass the weekday and this tool finds the date.',
      ),
  }),

  risk: "read",
  roles: ["end_user", "operator"],

  conditions: {
    callWhen: [
      "The person asks whether the restaurant is open",
      "The person asks what time it opens or closes",
      "The person asks whether a particular day or time works",
      "The person asks about a day this coming week",
    ],
    dontCallWhen: [
      "The person is not asking about opening times at all",
      "The hours for that exact day were already given in this conversation",
    ],
  },

  examples: {
    should: [
      "are you open now?",
      "what time do you close on Friday?",
      "are you open on Sunday evening?",
      "do you open at 11 tomorrow?",
      "are you open on Monday lunchtime?",
    ],
    shouldNot: [
      "do you have paneer tikka?",
      "where are you?",
      "can I book a table for six?",
      "how much is the thali?",
      "thanks, see you then",
    ],
  },

  handler: async (args, ctx) => {
    const date = resolveDate(args.day, ctx.clock.now())

    const exception = config.hours.exceptions?.find((entry) => entry.date === date)
    if (exception?.closed === true) {
      return { date, open: false, why: "closed that day" }
    }

    const ranges = exception?.ranges ?? config.hours[dayOf(new Date(`${date}T12:00:00Z`))]
    if (ranges === undefined || ranges.length === 0) {
      return { date, open: false, why: "closed that day" }
    }

    return {
      date,
      open: true,
      ranges: ranges.map(([from, to]) => ({ from, to })),
      timezone: config.timezone,
    }
  },
})
