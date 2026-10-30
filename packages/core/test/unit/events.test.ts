// EVT-1 to EVT-3: the event trace.
//
// The names are checked against the Spec's own table, so adding an event
// to one and not the other fails here rather than quietly drifting.
import { test, expect, describe } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  EVENT_NAMES,
  createEvents,
  noEvents,
  type EventName,
  type EventStore,
} from "../../src/runtime/events.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import { tsFiles, withoutComments } from "../support/source.ts"
import { FLAG_KINDS, type FlagKind } from "../../src/store/tables.ts"

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
  written: Record<string, Record<string, unknown>[]>
} {
  const rows: Record<string, unknown>[] = []
  const written: Record<string, Record<string, unknown>[]> = {
    ob_tool_runs: [],
    ob_decisions: [],
    ob_flags: [],
  }

  const table = (name: string) => ({
    insert: async (row: Record<string, unknown>) => {
      if (options.fail === true) throw new Error("no database")
      written[name]?.push(row)
      return { id: `${name}-${String(written[name]?.length)}` }
    },
  })

  return {
    rows,
    written,
    events: {
      insert: async (row) => {
        if (options.fail === true) throw new Error("no database")
        rows.push(row)
        return { id: `e${rows.length}` }
      },
    },
    toolRuns: table("ob_tool_runs"),
    flags: table("ob_flags"),
    decisions: {
      ...table("ob_decisions"),
      // Newest first, as the real store is asked for them.
      list: async (where, listOptions = {}) => {
        if (options.fail === true) throw new Error("no database")
        const matching = (written["ob_decisions"] ?? []).filter((row) =>
          Object.entries(where).every(([column, value]) => row[column] === value),
        )
        const ordered = [...matching].reverse()
        return ordered.slice(0, listOptions.limit ?? ordered.length) as { outcome: string }[]
      },
    },
  }
}

/** The kinds in LEARN-1's table, read out of the Spec. */
function flagKindsInSpec(markdown: string): string[] {
  const from = markdown.indexOf("**LEARN-1.**")
  if (from === -1) throw new Error("LEARN-1 is not in the Spec")
  const after = markdown.indexOf("**LEARN-2.**", from)
  const block = markdown.slice(from, after === -1 ? undefined : after)

  const found: string[] = []
  for (const line of block.split("\n")) {
    if (!line.startsWith("|")) continue
    const first = line.split("|").slice(1, -1)[0]
    if (first === undefined) continue
    const match = /`([a-z_]+)`/.exec(first)
    if (match?.[1] !== undefined) found.push(match[1])
  }
  return found
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

describe("LEARN-1: the flag kinds", () => {
  test("LEARN-1: every kind in the Spec's table exists in the code", () => {
    const missing = flagKindsInSpec(SPEC).filter((kind) => !FLAG_KINDS.includes(kind as FlagKind))
    expect(missing).toEqual([])
  })

  test("LEARN-1: the code invents no kind the Spec does not list", () => {
    const inSpec = new Set(flagKindsInSpec(SPEC))
    expect(FLAG_KINDS.filter((kind) => !inSpec.has(kind))).toEqual([])
  })

  // A kind that is declared, allowed by the constraint and raised by
  // nothing is a flag the Spec promises and the agent never produces. The
  // list and the Spec agreed long before four of the ten were raised
  // anywhere, so agreement between those two proves less than it looks.
  test("LEARN-1: every kind the Spec lists is raised somewhere in the core", () => {
    const src = join(import.meta.dir, "..", "..", "src")
    const raised = new Set<string>()
    for (const file of tsFiles(src)) {
      const text = withoutComments(readFileSync(join(src, file), "utf8"))
      for (const match of text.matchAll(/\.flag\(\s*"([a-z_]+)"/g)) {
        const kind = match[1]
        if (kind !== undefined) raised.add(kind)
      }
    }
    expect(FLAG_KINDS.filter((kind) => !raised.has(kind))).toEqual([])
  })

  // CONF-4 refuses for seven different reasons, and LEARN-1 wants a flag
  // for every one. One of the seven is the loser of two taps arriving
  // together, which needs an interleaving between a status read and a
  // conditional update: no test can reach it from outside, and it was
  // already written as a bare `record` before this row, so it would have
  // been the one left unflagged.
  //
  // So the rule is structural instead. Every rejection goes through one
  // helper that records and flags together, and this holds the file to
  // that: one place writes the event, so a reason added later cannot
  // record without flagging.
  test("LEARN-1: every CONF-4 rejection is recorded in one place, so none can skip its flag", () => {
    const src = join(import.meta.dir, "..", "..", "src", "runtime", "confirm.ts")
    const text = withoutComments(readFileSync(src, "utf8"))

    const writes = [...text.matchAll(/\brecord\(\s*"confirmation_rejected"/g)]
    expect(writes).toHaveLength(1)
    // And that one place flags it too.
    expect(text).toContain('flag("confirmation_rejected"')
  })

  test("LEARN-1: the migration accepts exactly those kinds and no others", () => {
    // A kind the type allows and the check constraint refuses would be a
    // flag that is raised in a test and lost in production.
    //
    // Read from the migrations in order, because a constraint can be
    // replaced: 0007 writes it and 0014 widened it for `send_blocked`.
    // The one that counts is the last one declared, in the last
    // migration that touches the table.
    const dir = join(import.meta.dir, "..", "..", "migrations")
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()

    let last = ""
    for (const name of files) {
      const sql = readFileSync(join(dir, name), "utf8")
      if (!sql.includes("ob_flags")) continue
      const blocks = [...sql.matchAll(/check \(kind in \(([^)]*)\)\)/g)]
      const block = blocks[blocks.length - 1]?.[1]
      if (block !== undefined) last = block
    }

    const allowed = [...last.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as FlagKind)
    expect([...new Set(allowed)].sort()).toEqual([...FLAG_KINDS].sort())
  })
})

describe("DATA-2: the three tables the trace also writes", () => {
  const clock = fixedClock("2026-10-19T06:00:00Z")

  const writer = (store: ReturnType<typeof fakeStore>) =>
    createEvents({ store, clock }).about({ personId: "p1", turnId: "t1" })

  test("DATA-2: a tool run records what the tool was given", async () => {
    // Known K6: this is the one thing the event trace could not say.
    const store = fakeStore()
    await writer(store).toolRun({
      tool: "book_table",
      risk: "write",
      status: "ok",
      args: { size: 4, date: "2026-10-19" },
      result: { booked: true },
      step: 2,
      durationMs: 12,
    })

    expect(store.written["ob_tool_runs"]?.[0]).toMatchObject({
      person_id: "p1",
      turn_id: "t1",
      step: 2,
      tool: "book_table",
      risk: "write",
      args: { size: 4, date: "2026-10-19" },
      result: { booked: true },
      status: "ok",
      duration_ms: 12,
    })
  })

  test("DATA-2: a result JSON cannot carry does not lose the arguments with it", async () => {
    const store = fakeStore()
    const cycle: Record<string, unknown> = { name: "loop" }
    cycle["self"] = cycle

    await writer(store).toolRun({
      tool: "book_table",
      risk: "write",
      status: "ok",
      args: { size: 4 },
      result: cycle,
      step: 1,
      durationMs: 0,
    })

    const row = store.written["ob_tool_runs"]?.[0]
    expect(row?.["args"]).toEqual({ size: 4 })
    expect(row?.["result"]).toEqual({ unrecorded: "this value could not be written as JSON" })
  })

  test("DATA-2: a decision records the outcome, the model and what it cost", async () => {
    const store = fakeStore()
    await writer(store).decision({
      kind: "gate",
      outcome: "block",
      answers: { gate: { type: "yesno", p: 0.1 } },
      model: "jev",
      step: 1,
      durationMs: 40,
      costUsd: 0.00004,
    })

    expect(store.written["ob_decisions"]?.[0]).toMatchObject({
      kind: "gate",
      outcome: "block",
      model: "jev",
      step: 1,
      duration_ms: 40,
      cost_usd: 0.00004,
    })
  })

  test("GATE-3: the same outcome twice in a row for one person is reported", async () => {
    const store = fakeStore()
    const events = writer(store)
    const block = {
      kind: "gate",
      outcome: "block",
      model: "jev",
      durationMs: 0,
      costUsd: 0,
    } as const

    expect((await events.decision(block)).repeated).toBe(false)
    expect((await events.decision(block)).repeated).toBe(true)
  })

  test("GATE-3: a different outcome in between breaks the run", async () => {
    const store = fakeStore()
    const events = writer(store)
    const gate = (outcome: string) =>
      ({ kind: "gate", outcome, model: "jev", durationMs: 0, costUsd: 0 }) as const

    await events.decision(gate("block"))
    expect((await events.decision(gate("pass"))).repeated).toBe(false)
    expect((await events.decision(gate("block"))).repeated).toBe(false)
  })

  test("GATE-3: another person's blocks are not this person's", async () => {
    const store = fakeStore()
    const base = createEvents({ store, clock })
    const block = {
      kind: "gate",
      outcome: "block",
      model: "jev",
      durationMs: 0,
      costUsd: 0,
    } as const

    await base.about({ personId: "p1" }).decision(block)
    expect((await base.about({ personId: "p2" }).decision(block)).repeated).toBe(false)
  })

  test("GATE-3: routing and the gate are counted apart", async () => {
    // A block and a low confidence pick are two different triggers, so one
    // of each is not two of either.
    const store = fakeStore()
    const events = writer(store)

    await events.decision({
      kind: "gate",
      outcome: "block",
      model: "jev",
      durationMs: 0,
      costUsd: 0,
    })
    const routed = await events.decision({
      kind: "route",
      outcome: "block",
      model: "jev",
      durationMs: 0,
      costUsd: 0,
    })

    expect(routed.repeated).toBe(false)
  })

  test("LEARN-1: a flag is a row and an event, so neither has to be joined", async () => {
    const store = fakeStore()
    await writer(store).flag("gate_block", { tool: "book_table", p: 0.1 })

    expect(store.written["ob_flags"]?.[0]).toMatchObject({
      person_id: "p1",
      turn_id: "t1",
      kind: "gate_block",
      detail: { tool: "book_table", p: 0.1 },
    })
    expect(store.rows[0]).toMatchObject({ name: "flag_raised" })
    expect(store.rows[0]?.["props"]).toMatchObject({ kind: "gate_block", tool: "book_table" })
  })

  test("a row that cannot be written is a failure, not a thrown error", async () => {
    const store = fakeStore({ fail: true })
    const events = writer(store)

    await events.toolRun({
      tool: "book_table",
      risk: "write",
      status: "ok",
      args: {},
      step: 1,
      durationMs: 0,
    })
    await events.flag("gate_block")
    const decided = await events.decision({
      kind: "gate",
      outcome: "block",
      model: "jev",
      durationMs: 0,
      costUsd: 0,
    })

    // The turn carries on, and the count nobody could write is not claimed.
    expect(decided.repeated).toBe(false)
    expect(events.failures.map((failure) => failure.name)).toContain("ob_tool_runs")
    expect(events.failures.map((failure) => failure.name)).toContain("ob_flags")
  })
})

describe("noEvents", () => {
  test("it records nothing and never fails", async () => {
    const events = noEvents()
    await events.record("turn_started", { a: 1 })
    await events.about({ personId: "p1" }).record("turn_ended")
    await events.toolRun({
      tool: "x",
      risk: "read",
      status: "ok",
      args: {},
      step: 1,
      durationMs: 0,
    })
    await events.flag("gate_block")
    expect(
      (
        await events.decision({
          kind: "gate",
          outcome: "block",
          model: "none",
          durationMs: 0,
          costUsd: 0,
        })
      ).repeated,
    ).toBe(false)
    expect(events.failures).toEqual([])
  })
})
