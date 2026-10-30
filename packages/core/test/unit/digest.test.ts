// LEARN-3: when the digest goes out, what week it covers, and how it
// reads. The numbers it reports are an integration test; this is the
// arithmetic, which is where a timezone bug would hide.
import { test, expect, describe } from "bun:test"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import {
  digestText,
  digestWindow,
  median,
  nextDigestAt,
  type Digest,
} from "../../src/runtime/digest.ts"

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: [["11:00", "23:00"]] },
    brain: { id: "openrouter", model: "test/model" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages.",
    retentionDays: 365,
    ...over,
  })
}

/** What the agent's own clock reads at an instant. */
const inZone = (at: Date, timezone = "Asia/Kolkata") =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at)

describe("LEARN-3: when the next digest is due", () => {
  test("LEARN-3: Monday at 09:00 in the agent's timezone, not the server's", () => {
    // 2026-10-28 is a Wednesday. The server here may be anywhere, so the
    // assertion is on what the agent's own clock reads.
    const next = nextDigestAt(new Date("2026-10-28T00:00:00Z"), config())

    expect(inZone(next)).toBe("Mon 09:00")
  })

  test("LEARN-3: earlier the same day means today, not next week", () => {
    // 2026-11-02 is a Monday. 02:00 UTC is 07:30 in Kolkata, before 09:00.
    const next = nextDigestAt(new Date("2026-11-02T02:00:00Z"), config())

    expect(next.toISOString()).toBe("2026-11-02T03:30:00.000Z")
  })

  test("LEARN-3: exactly on the hour is the next one, so a digest never repeats itself", () => {
    // The instant a digest is due is the instant its handler asks for the
    // following one. Were this not strict, that would book the same
    // moment again and the agent would send the same digest for ever.
    const due = new Date("2026-11-02T03:30:00Z")

    const next = nextDigestAt(due, config())

    expect(next.toISOString()).toBe("2026-11-09T03:30:00.000Z")
  })

  test("LEARN-3: later the same day waits for next week", () => {
    const next = nextDigestAt(new Date("2026-11-02T06:00:00Z"), config())

    expect(next.toISOString()).toBe("2026-11-09T03:30:00.000Z")
  })

  test("LEARN-3: the builder's own day and hour are what decide", () => {
    const next = nextDigestAt(
      new Date("2026-10-28T00:00:00Z"),
      config({ learning: { digestDay: "fri", digestHour: 17 } }),
    )

    expect(inZone(next)).toBe("Fri 17:00")
  })

  test("LEARN-3: it crosses a month end without help", () => {
    // From Thursday 2026-10-29, the next Monday is in November.
    const next = nextDigestAt(new Date("2026-10-29T12:00:00Z"), config())

    expect(next.toISOString()).toBe("2026-11-02T03:30:00.000Z")
  })

  test("LEARN-3: an agent in another timezone gets its own nine o'clock", () => {
    const next = nextDigestAt(
      new Date("2026-10-28T00:00:00Z"),
      config({ timezone: "America/New_York" }),
    )

    expect(inZone(next, "America/New_York")).toBe("Mon 09:00")
    // And that is a different instant from Kolkata's, which is the whole
    // point of reading the hour in the agent's own zone.
    expect(next.toISOString()).not.toBe(
      nextDigestAt(new Date("2026-10-28T00:00:00Z"), config()).toISOString(),
    )
  })
})

describe("LEARN-3: the week a digest covers", () => {
  const due = new Date("2026-11-02T03:30:00Z")

  test("LEARN-3: the seven days up to when it was due", () => {
    const window = digestWindow(due)

    expect(window.to.toISOString()).toBe("2026-11-02T03:30:00.000Z")
    expect(window.from.toISOString()).toBe("2026-10-26T03:30:00.000Z")
  })

  test("LEARN-3: and the seven before those, which is what it compares against", () => {
    const window = digestWindow(due)

    expect(window.previousFrom.toISOString()).toBe("2026-10-19T03:30:00.000Z")
  })

  // The builder's choice when this was built: a digest the agent was down
  // for goes out late rather than being lost. That only works if the week
  // comes from when it was due, not from when it ran.
  test("LEARN-3: a digest that runs late still covers the week it was due for", () => {
    const ranOn = new Date("2026-11-04T10:00:00Z")
    const window = digestWindow(due)

    expect(window.to.getTime()).toBeLessThan(ranOn.getTime())
    expect(window.to.toISOString()).toBe(due.toISOString())
  })
})

describe("LEARN-3: the median latency", () => {
  // LEARN-3 asks for a median, and a mean is the easy mistake. The
  // difference is the whole reason it asks: one slow turn drags a mean
  // and leaves a median alone, and "how long does this usually take" is
  // the question a builder is asking.
  test("LEARN-3: it is the middle value, not the average", () => {
    // Mean 2400, median 200. One timeout should not move it.
    expect(median([100, 200, 300, 11_400])).toBe(250)
    expect(median([100, 200, 300, 11_400])).not.toBe(3000)
  })

  test("LEARN-3: an odd count takes the middle one", () => {
    expect(median([5, 1, 3])).toBe(3)
  })

  test("LEARN-3: an even count takes the middle two", () => {
    expect(median([1, 2, 3, 10])).toBe(2.5)
  })

  test("LEARN-3: no turns is no median, rather than zero", () => {
    // Zero would read as "instant" in the digest, which is a lie about a
    // week when nothing ran.
    expect(median([])).toBeNull()
  })

  test("LEARN-3: the order it arrives in does not matter", () => {
    expect(median([300, 100, 200])).toBe(median([100, 200, 300]))
  })
})

describe("LEARN-3: how the digest reads", () => {
  const full: Digest = {
    from: "2026-10-26T03:30:00.000Z",
    to: "2026-11-02T03:30:00.000Z",
    turns: 120,
    spendUsd: 1.2345,
    medianLatencyMs: 2400,
    flags: [
      { kind: "handover", count: 7, before: 3 },
      { kind: "tool_error", count: 2, before: 2 },
      { kind: "frustration", count: 1, before: 4 },
    ],
    worst: [
      { personId: "p1", name: "Riya", channel: "whatsapp", flags: 5 },
      { personId: "p2", name: null, channel: "telegram", flags: 3 },
    ],
  }

  test("LEARN-3: it says which week it covers, because it may arrive late", () => {
    const text = digestText(full, "Asia/Kolkata")

    // The dates as the builder's agent reads them, not as UTC.
    expect(text).toContain("2026-10-26")
    expect(text).toContain("2026-11-02")
  })

  test("LEARN-3: flag counts by kind, against the week before", () => {
    const text = digestText(full, "Asia/Kolkata")

    expect(text).toContain("handover")
    expect(text).toContain("7")
    // The comparison is the point of the line: 7 after 3 is a direction,
    // where 7 on its own is a number nobody can act on.
    expect(text).toMatch(/handover\D+7\D+3/)
  })

  test("LEARN-3: a kind that did not happen at all is left out, not listed as zero", () => {
    const text = digestText(full, "Asia/Kolkata")

    expect(text).not.toContain("unknown_tool")
  })

  test("LEARN-3: spend and median latency", () => {
    const text = digestText(full, "Asia/Kolkata")

    expect(text).toContain("1.23")
    expect(text).toContain("2400")
  })

  test("LEARN-3: the worst conversations, named the way a person is named", () => {
    const text = digestText(full, "Asia/Kolkata")

    expect(text).toContain("Riya")
    // Nobody gave the second one a name, so the channel stands in rather
    // than an empty space or a raw id on its own.
    expect(text).toContain("telegram")
  })

  test("LEARN-3: a quiet week says so, rather than printing a wall of zeroes", () => {
    const quiet: Digest = {
      from: "2026-10-26T03:30:00.000Z",
      to: "2026-11-02T03:30:00.000Z",
      turns: 0,
      spendUsd: 0,
      medianLatencyMs: null,
      flags: [],
      worst: [],
    }

    const text = digestText(quiet, "Asia/Kolkata")

    expect(text.toLowerCase()).toContain("nothing")
    expect(text).toContain("2026-10-26")
  })

  test("LEARN-3: a week with turns but no flags says the flags were none", () => {
    const clean: Digest = { ...full, flags: [], worst: [] }

    const text = digestText(clean, "Asia/Kolkata")

    expect(text.toLowerCase()).toContain("no flags")
    expect(text).toContain("120")
  })
})
