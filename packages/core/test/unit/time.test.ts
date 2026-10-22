// TIME-1 to TIME-4: the time helpers, on a frozen clock.
//
// C15 is the criterion: "with a frozen clock, 'tomorrow 8pm' resolves
// correctly across midnight, month end and the agent's timezone. A request
// outside opening hours is refused by tool code even when the brain tries."
//
// The reason this row exists at all is a real failure, in the M1 live run:
// the demo tool took a raw date, the brain worked out which day Friday was,
// got it wrong, and told someone Sunday's opening hours. So the tests that
// matter most here are the ones where the answer depends on the agent's
// timezone rather than the machine's, and the ones where a phrase is not
// certain enough to act on.
import { test, expect, describe } from "bun:test"
import { createTimeHelpers } from "../../src/time/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { fixedClock } from "../../src/testing/clock.ts"

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: {
      mon: [
        ["11:00", "15:00"],
        ["19:00", "23:00"],
      ],
      tue: [
        ["11:00", "15:00"],
        ["19:00", "23:00"],
      ],
      wed: [
        ["11:00", "15:00"],
        ["19:00", "23:00"],
      ],
      thu: [
        ["11:00", "15:00"],
        ["19:00", "23:00"],
      ],
      fri: [
        ["11:00", "15:00"],
        ["19:00", "23:30"],
      ],
      sat: [["11:00", "23:30"]],
      sun: [],
    },
    brain: { id: "openrouter", model: "test/model" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages.",
    retentionDays: 365,
    ...over,
  } as never)
}

/** Helpers frozen at an instant, expressed in the agent's own timezone. */
const at = (iso: string, over: Record<string, unknown> = {}) =>
  createTimeHelpers({ config: config(over), clock: fixedClock(iso) })

/** What an exact resolution means, in the agent's timezone. */
const zoned = (date: Date, timezone = "Asia/Kolkata") =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)

describe("TIME-2: resolve", () => {
  test("TIME-2: tomorrow 8pm is tomorrow at 20:00 in the agent's timezone", () => {
    // 2026-10-19T06:00:00Z is 11:30 on Monday the 19th in Kolkata.
    const resolved = at("2026-10-19T06:00:00Z").resolve("tomorrow 8pm")

    expect(resolved.kind).toBe("exact")
    if (resolved.kind !== "exact") return
    expect(zoned(resolved.at)).toBe("Tue, 20/10/2026, 20:00")
  })

  test("C15: across midnight, tomorrow is still the next calendar day here", () => {
    // 2026-10-19T19:00:00Z is 00:30 on Tuesday the 20th in Kolkata, and
    // still Monday the 19th in London. A server in either place must give
    // the same answer, and it is the agent's zone that decides.
    const resolved = at("2026-10-19T19:00:00Z").resolve("tomorrow 8pm")

    expect(resolved.kind).toBe("exact")
    if (resolved.kind !== "exact") return
    expect(zoned(resolved.at)).toBe("Wed, 21/10/2026, 20:00")
  })

  test("C15: across month end, tomorrow rolls the month over", () => {
    // 31 October, in Kolkata.
    const resolved = at("2026-10-31T06:00:00Z").resolve("tomorrow 8pm")

    expect(resolved.kind).toBe("exact")
    if (resolved.kind !== "exact") return
    expect(zoned(resolved.at)).toBe("Sun, 01/11/2026, 20:00")
  })

  test("C15: across a year end too", () => {
    const resolved = at("2026-12-31T06:00:00Z").resolve("tomorrow 8pm")

    expect(resolved.kind).toBe("exact")
    if (resolved.kind !== "exact") return
    expect(zoned(resolved.at)).toBe("Fri, 01/01/2027, 20:00")
  })

  test("TIME-1: the same phrase and instant in another timezone is another answer", () => {
    // The whole point of TIME-1. The instant is identical; only the
    // agent's timezone differs, and the resolved wall clock follows it.
    const instant = "2026-10-19T19:00:00Z"
    const here = at(instant).resolve("tomorrow 8pm")
    const london = at(instant, { timezone: "Europe/London" }).resolve("tomorrow 8pm")

    expect(here.kind).toBe("exact")
    expect(london.kind).toBe("exact")
    if (here.kind !== "exact" || london.kind !== "exact") return
    // In Kolkata it is already the 20th, so tomorrow is the 21st. In
    // London it is still the 19th, so tomorrow is the 20th.
    expect(zoned(here.at)).toBe("Wed, 21/10/2026, 20:00")
    expect(zoned(london.at, "Europe/London")).toBe("Tue, 20/10/2026, 20:00")
  })

  test("TIME-2: in 2 hours counts from the agent's now, not the server's", () => {
    const resolved = at("2026-10-19T06:00:00Z").resolve("in 2 hours")

    expect(resolved.kind).toBe("exact")
    if (resolved.kind !== "exact") return
    // 11:30 plus two hours, in Kolkata.
    expect(zoned(resolved.at)).toBe("Mon, 19/10/2026, 13:30")
  })

  test("TIME-2: a date and a time together resolves exactly", () => {
    const resolved = at("2026-10-19T06:00:00Z").resolve("23 October at 19:30")

    expect(resolved.kind).toBe("exact")
    if (resolved.kind !== "exact") return
    expect(zoned(resolved.at)).toBe("Fri, 23/10/2026, 19:30")
  })

  test("TIME-2: filler words around the phrase do not stop it resolving", () => {
    const resolved = at("2026-10-19T06:00:00Z").resolve("could we do tomorrow 8pm please")

    expect(resolved.kind).toBe("exact")
    if (resolved.kind !== "exact") return
    expect(zoned(resolved.at)).toBe("Tue, 20/10/2026, 20:00")
  })
})

describe("TIME-3: what is not certain enough to act on", () => {
  test("TIME-3: a day with no time of day is ambiguous, not noon", () => {
    // The parser will happily default to midday. Booking a table at noon
    // because of that is the kind of guess that loses the table.
    const resolved = at("2026-10-19T06:00:00Z").resolve("friday")

    expect(resolved.kind).toBe("ambiguous")
    if (resolved.kind !== "ambiguous") return
    expect(resolved.why).toContain("no time of day")
    expect(resolved.why).toContain("Friday 23 October")
  })

  test("TIME-3: a phrase that is not a time at all is ambiguous", () => {
    const resolved = at("2026-10-19T06:00:00Z").resolve("sometime soonish")

    expect(resolved.kind).toBe("ambiguous")
    if (resolved.kind !== "ambiguous") return
    expect(resolved.why).toContain("not a date or time")
  })

  test("TIME-3: an empty phrase is ambiguous rather than now", () => {
    expect(at("2026-10-19T06:00:00Z").resolve("   ").kind).toBe("ambiguous")
  })

  test("TIME-3: a partly understood phrase is ambiguous, not confidently wrong", () => {
    // Found by running the parser: "the 31st at 9" comes back as "at 9" on
    // today's date, with the 31st silently dropped. A confident wrong date
    // is the worst answer this file could give.
    const resolved = at("2026-10-19T06:00:00Z").resolve("the 31st at 9")

    expect(resolved.kind).toBe("ambiguous")
    if (resolved.kind !== "ambiguous") return
    expect(resolved.why).toContain("at 9")
    expect(resolved.why).toContain("rest looks like part of the date")
  })

  test("TIME-3: a bare weekday with a time is acted on, as the one coming", () => {
    // Not ambiguous. Asking "which Friday?" every time somebody says
    // Friday is worse than reading the date back, which is what the tool
    // does with `format`.
    const resolved = at("2026-10-19T06:00:00Z").resolve("friday 8pm")

    expect(resolved.kind).toBe("exact")
    if (resolved.kind !== "exact") return
    expect(resolved.text).toBe("Friday 23 October at 20:00")
  })

  test("TIME-3: next friday is ambiguous, because in English it is", () => {
    // The Friday coming, or the one after it. People mean both.
    const resolved = at("2026-10-19T06:00:00Z").resolve("next friday 8pm")

    expect(resolved.kind).toBe("ambiguous")
    if (resolved.kind !== "ambiguous") return
    expect(resolved.why).toContain("the one coming or the one after")
    expect(resolved.candidates).toHaveLength(2)
    const days = resolved.candidates.map((candidate) => zoned(candidate.at))
    expect(days[0]).toContain("23/10/2026")
    expect(days[1]).toContain("30/10/2026")
  })

  test("TIME-3: two times in one phrase is ambiguous, with both as candidates", () => {
    const resolved = at("2026-10-19T06:00:00Z").resolve("friday 7pm or saturday 8pm")

    expect(resolved.kind).toBe("ambiguous")
    if (resolved.kind !== "ambiguous") return
    expect(resolved.why).toContain("more than one time")
    expect(resolved.candidates.length).toBeGreaterThan(1)
    expect(resolved.candidates.map((candidate) => zoned(candidate.at))).toEqual([
      "Fri, 23/10/2026, 19:00",
      "Sat, 24/10/2026, 20:00",
    ])
  })

  test("TIME-3: a candidate carries the words to read back to the person", () => {
    const resolved = at("2026-10-19T06:00:00Z").resolve("friday 7pm or saturday 8pm")

    expect(resolved.kind).toBe("ambiguous")
    if (resolved.kind !== "ambiguous") return
    expect(resolved.candidates[0]?.text).toBe("Friday 23 October at 19:00")
  })
})

describe("TIME-2: isOpen", () => {
  const helpers = at("2026-10-19T06:00:00Z")
  const instant = (local: string) => new Date(local)

  test("TIME-2: inside a range is open", () => {
    // 12:00 Monday in Kolkata is 06:30Z.
    expect(helpers.isOpen(instant("2026-10-19T06:30:00Z"))).toBe(true)
  })

  test("TIME-2: between two ranges is closed", () => {
    // 17:00 Monday in Kolkata, which is between lunch and dinner.
    expect(helpers.isOpen(instant("2026-10-19T11:30:00Z"))).toBe(false)
  })

  test("TIME-2: the closing time itself is closed", () => {
    // 15:00 Monday exactly. The kitchen shuts at 15:00, so 15:00 is shut.
    expect(helpers.isOpen(instant("2026-10-19T09:30:00Z"))).toBe(false)
    // And 14:59 is open.
    expect(helpers.isOpen(instant("2026-10-19T09:29:00Z"))).toBe(true)
  })

  test("TIME-2: the opening time itself is open", () => {
    expect(helpers.isOpen(instant("2026-10-19T05:30:00Z"))).toBe(true)
  })

  test("TIME-2: a day with no hours is closed all day", () => {
    // Sunday the 25th, which has no ranges at all.
    expect(helpers.isOpen(instant("2026-10-25T06:30:00Z"))).toBe(false)
  })

  test("TIME-2: it reads the day in the agent's timezone, not the server's", () => {
    // 2026-10-25T18:30:00Z is 00:00 on Monday the 26th in Kolkata, which
    // is closed, and still Sunday evening in London. Getting the day wrong
    // here is exactly the live bug this row exists for.
    expect(helpers.isOpen(instant("2026-10-25T18:30:00Z"))).toBe(false)
    // 06:30 on Monday the 26th in Kolkata is 01:00Z, still closed.
    expect(helpers.isOpen(instant("2026-10-26T01:00:00Z"))).toBe(false)
    // 11:30 Monday in Kolkata is 06:00Z, open.
    expect(helpers.isOpen(instant("2026-10-26T06:00:00Z"))).toBe(true)
  })

  test("TIME-2: a closed exception beats the weekly hours", () => {
    const closed = at("2026-10-19T06:00:00Z", {
      hours: {
        mon: [["11:00", "23:00"]],
        exceptions: [{ date: "2026-10-19", closed: true }],
      },
    })
    expect(closed.isOpen(instant("2026-10-19T06:30:00Z"))).toBe(false)
  })

  test("TIME-2: an exception with its own ranges replaces the day's", () => {
    const special = at("2026-10-19T06:00:00Z", {
      hours: {
        mon: [["11:00", "15:00"]],
        exceptions: [{ date: "2026-10-19", ranges: [["18:00", "20:00"]] }],
      },
    })
    // Midday, which the weekly hours would have had open.
    expect(special.isOpen(instant("2026-10-19T06:30:00Z"))).toBe(false)
    // 18:30, which only the exception opens.
    expect(special.isOpen(instant("2026-10-19T13:00:00Z"))).toBe(true)
  })
})

describe("TIME-2: nextOpen", () => {
  const helpers = at("2026-10-19T06:00:00Z")

  test("TIME-2: from between two ranges it is the next range today", () => {
    // 17:00 Monday in Kolkata, so the answer is 19:00 the same day.
    const next = helpers.nextOpen(new Date("2026-10-19T11:30:00Z"))
    expect(next).not.toBeNull()
    expect(zoned(next!)).toBe("Mon, 19/10/2026, 19:00")
  })

  test("TIME-2: after the last range it is tomorrow morning", () => {
    // 23:30 Monday in Kolkata.
    const next = helpers.nextOpen(new Date("2026-10-19T18:00:00Z"))
    expect(zoned(next!)).toBe("Tue, 20/10/2026, 11:00")
  })

  test("TIME-2: it skips a day with no hours", () => {
    // Saturday evening, so the next opening is Monday, because Sunday has
    // no ranges.
    const next = helpers.nextOpen(new Date("2026-10-24T18:30:00Z"))
    expect(zoned(next!)).toBe("Mon, 26/10/2026, 11:00")
  })

  test("TIME-2: an agent that is never open answers null rather than a guess", () => {
    const never = at("2026-10-19T06:00:00Z", { hours: {} })
    expect(never.nextOpen(new Date("2026-10-19T06:00:00Z"))).toBeNull()
  })
})

describe("TIME-2: format", () => {
  test("TIME-2: a time is written in the agent's timezone", () => {
    expect(at("2026-10-19T06:00:00Z").format(new Date("2026-10-20T14:30:00Z"))).toBe(
      "Tuesday 20 October at 20:00",
    )
  })

  test("TIME-2: a date in another year says which year", () => {
    expect(at("2026-10-19T06:00:00Z").format(new Date("2027-01-01T14:30:00Z"))).toBe(
      "Friday 1 January 2027 at 20:00",
    )
  })
})

describe("TIME-2: rangesOn", () => {
  test("TIME-2: the day's ranges, after exceptions", () => {
    expect(at("2026-10-19T06:00:00Z").rangesOn(new Date("2026-10-19T06:00:00Z"))).toEqual([
      ["11:00", "15:00"],
      ["19:00", "23:00"],
    ])
  })

  test("TIME-2: a day with none comes back empty, not undefined", () => {
    expect(at("2026-10-19T06:00:00Z").rangesOn(new Date("2026-10-25T06:00:00Z"))).toEqual([])
  })
})
