// EVT-1 to EVT-3: the event trace.
//
// The names are checked against the Spec's own table, so adding an event
// to one and not the other fails here rather than quietly drifting.
import { test, expect, describe } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  EVENT_NAMES,
  createEvents,
  noEvents,
  type EventName,
  type EventStore,
} from "../../src/runtime/events.ts"
import { fixedClock } from "../../src/testing/clock.ts"

const SPEC = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "Spec.md"), "utf8")

/** The names in EVT-2's table, read out of the Spec. */
function namesInSpec(markdown: string): string[] {
  const from = markdown.indexOf("**EVT-2.**")
  if (from === -1) throw new Error("EVT-2 is not in the Spec")
  const after = markdown.indexOf("**EVT-3.**", from)
  const block = markdown.slice(from, after === -1 ? undefined : after)

  const found: string[] = []
  for (const line of block.split("\n")) {
    if (!line.startsWith("|")) continue
    const cells = line.split("|").slice(1, -1)
    const events = cells[1]
    if (events === undefined) continue
    for (const match of events.matchAll(/`([a-z_]+)`/g)) {
      const name = match[1]
      if (name !== undefined) found.push(name)
    }
  }
  return found
}

/** A store that records what was written, or refuses to write at all. */
function fakeStore(options: { fail?: boolean } = {}): EventStore & {
  rows: Record<string, unknown>[]
} {
  const rows: Record<string, unknown>[] = []
  return {
    rows,
    events: {
      insert: async (row) => {
        if (options.fail === true) throw new Error("no database")
        rows.push(row)
        return { id: `e${rows.length}` }
      },
    },
  }
}

/** A sink that records, or one that throws, like a bad analytics library. */
function fakeSink(options: { fail?: boolean } = {}): {
  captured: [string, Record<string, unknown>][]
  capture(event: string, props: Record<string, unknown>): void
} {
  const captured: [string, Record<string, unknown>][] = []
  return {
    captured,
    capture(event, props) {
      if (options.fail === true) throw new Error("the analytics library is broken")
      captured.push([event, props])
    },
  }
}

describe("EVT-2: the event names", () => {
  test("EVT-2: every name in the Spec's table exists in the code", () => {
    const missing = namesInSpec(SPEC).filter((name) => !EVENT_NAMES.includes(name as EventName))
    expect(missing).toEqual([])
  })

  test("EVT-2: the code invents no name the Spec does not list", () => {
    const inSpec = new Set(namesInSpec(SPEC))
    expect(EVENT_NAMES.filter((name) => !inSpec.has(name))).toEqual([])
  })

  test("EVT-2: the Spec's table was actually read", () => {
    // Guards the test above: an empty list would make it pass for nothing.
    expect(namesInSpec(SPEC).length).toBeGreaterThan(20)
    expect(namesInSpec(SPEC)).toContain("turn_started")
  })

  test("EVT-3: there is no event for a brain call", () => {
    // Brain calls are visible because evals-agent wraps Brain.complete.
    expect(EVENT_NAMES.filter((name) => name.includes("brain"))).toEqual([])
  })
})

describe("EVT-1: recording an event", () => {
  const clock = fixedClock("2026-10-19T06:00:00Z")

  test("EVT-1: it writes to the events table and calls capture", async () => {
    const store = fakeStore()
    const sink = fakeSink()
    const events = createEvents({ store, clock, sink })

    await events.record("turn_started", { channel: "whatsapp" })

    expect(store.rows).toEqual([
      {
        name: "turn_started",
        props: { channel: "whatsapp" },
        person_id: null,
        turn_id: null,
        created_at: "2026-10-19T06:00:00.000Z",
      },
    ])
    expect(sink.captured).toEqual([["turn_started", { channel: "whatsapp" }]])
  })

  test("EVT-1: an event with no props still records", async () => {
    const store = fakeStore()
    const events = createEvents({ store, clock })

    await events.record("turn_ended")
    expect(store.rows[0]).toMatchObject({ name: "turn_ended", props: {} })
  })

  test("EVT-1: capture is optional, and the table write happens without it", async () => {
    const store = fakeStore()
    const events = createEvents({ store, clock })

    await events.record("tool_ran", { tool: "check_availability" })
    expect(store.rows).toHaveLength(1)
  })

  test("EVT-1: `about` stamps the person and the turn on every event", async () => {
    const store = fakeStore()
    const events = createEvents({ store, clock })

    await events.about({ personId: "p1", turnId: "t1" }).record("turn_started")

    expect(store.rows[0]).toMatchObject({ person_id: "p1", turn_id: "t1" })
  })

  test("EVT-1: the clock decides created_at, not the database", async () => {
    const moving = fixedClock("2026-10-19T06:00:00Z")
    const store = fakeStore()
    const events = createEvents({ store, clock: moving })

    await events.record("turn_started")
    moving.advance(5_000)
    await events.record("turn_ended")

    expect(store.rows.map((row) => row["created_at"])).toEqual([
      "2026-10-19T06:00:00.000Z",
      "2026-10-19T06:00:05.000Z",
    ])
  })
})

describe("a failure to record never reaches the person", () => {
  const clock = fixedClock("2026-10-19T06:00:00Z")

  test("a database that refuses the write does not throw", async () => {
    const events = createEvents({ store: fakeStore({ fail: true }), clock })

    await events.record("turn_started")
    expect(events.failures).toHaveLength(1)
    expect(events.failures[0]).toMatchObject({ name: "turn_started", where: "table" })
  })

  test("a sink that throws does not stop the table write", async () => {
    const store = fakeStore()
    const events = createEvents({ store, clock, sink: fakeSink({ fail: true }) })

    await events.record("turn_started")
    expect(store.rows).toHaveLength(1)
    expect(events.failures[0]).toMatchObject({ where: "sink" })
  })

  test("a database that refuses the write does not stop the sink", async () => {
    const sink = fakeSink()
    const events = createEvents({ store: fakeStore({ fail: true }), clock, sink })

    await events.record("turn_started")
    expect(sink.captured).toHaveLength(1)
  })

  test("the glue can be told about a failure as it happens", async () => {
    const seen: string[] = []
    const events = createEvents({
      store: fakeStore({ fail: true }),
      clock,
      onError: (failure) => seen.push(`${failure.where}:${failure.name}`),
    })

    await events.record("turn_ended")
    expect(seen).toEqual(["table:turn_ended"])
  })

  test("an onError that throws is itself ignored", async () => {
    const events = createEvents({
      store: fakeStore({ fail: true }),
      clock,
      onError: () => {
        throw new Error("and this one is broken too")
      },
    })

    await events.record("turn_ended")
    expect(events.failures).toHaveLength(1)
  })

  test("failures from a scoped writer are reported with the rest", async () => {
    const events = createEvents({ store: fakeStore({ fail: true }), clock })

    await events.about({ personId: "p1" }).record("turn_started")
    expect(events.failures).toHaveLength(1)
  })
})

describe("noEvents", () => {
  test("it records nothing and never fails", async () => {
    const events = noEvents()
    await events.record("turn_started", { a: 1 })
    await events.about({ personId: "p1" }).record("turn_ended")
    expect(events.failures).toEqual([])
  })
})
