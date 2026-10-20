// The demo agent's one tool.
//
// It answers from the config's opening hours rather than from the prompt,
// which is the point: a date is a fact a tool looks up, never something a
// brain works out. The time helpers in `ctx.time` arrive in M4, so this
// does its own small lookup from the config.
import { defineTool, partsInZone } from "openbox-agent"
import { z } from "zod"
import config from "../agent.config.ts"

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
type Day = (typeof DAYS)[number]

/** The date the brain asked about, as a calendar date in the agent's zone. */
function resolveDate(asked: string, now: Date): string | undefined {
  const word = asked.trim().toLowerCase()

  if (word === "today") return partsInZone(now, config.timezone).date
  if (word === "tomorrow") {
    return partsInZone(new Date(now.getTime() + 86_400_000), config.timezone).date
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(word)) return word

  // A weekday name means the next time that day comes round, today included.
  const wanted = DAYS.indexOf(word.slice(0, 3) as Day)
  if (wanted === -1) return undefined

  for (let ahead = 0; ahead < 7; ahead++) {
    const at = new Date(now.getTime() + ahead * 86_400_000)
    if (dayOf(at) === DAYS[wanted]) return partsInZone(at, config.timezone).date
  }
  return undefined
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
      .string()
      .min(1)
      .describe('the day to look up: "today", "tomorrow", a weekday like "friday", or 2026-10-23'),
  }),

  risk: "read",
  roles: ["end_user", "operator"],

  conditions: {
    callWhen: [
      "The person asks whether the restaurant is open",
      "The person asks what time it opens or closes",
      "The person asks whether a particular day or time works",
      "The person asks about a holiday or a specific date",
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
      "are you shut for Diwali?",
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
    if (date === undefined) {
      return { known: false, why: `${args.day} is not a day I can look up` }
    }

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
