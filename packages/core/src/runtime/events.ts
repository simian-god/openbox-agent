// EVT-1 to EVT-3: the event trace.
//
// Every step of a turn records what it did, twice over: a row in
// `ob_events`, which is the agent's own durable trace, and a call to
// `deps.events.capture`, which is what evals-agent and any analytics the
// builder has already wired up listen to.
//
// Recording never breaks a conversation. A trace is for looking back at
// what happened, so a database that refuses the write, or an analytics
// library that throws, must not be the reason a person goes unanswered.
// Failures are collected and handed to `onError` instead.
//
// EVT-3: there is no event for a brain call. Brains are visible because
// evals-agent wraps `Brain.complete` directly.
//
// Three of DATA-2's tables are written from here too: `ob_tool_runs`,
// `ob_decisions` and `ob_flags`. They are the same job as an event, in a
// shape a query can answer questions about. An event says a tool ran; a
// tool run row says what it was given. An event says the gate blocked a
// call; GATE-3 has to ask whether that has now happened twice in a row for
// this person, which is a question about rows and not about a trace. They
// live here so there is one writer, one rule about failures, and one list
// of what could not be recorded.
import type { Clock } from "../testing/clock.ts"
import type { DecisionKind, FlagKind, ToolRunStatus } from "../store/tables.ts"

/**
 * EVT-2's names, as the Spec's table lists them. A test holds this list to
 * that table, so neither can drift from the other.
 *
 * Most of these are written by features that have not landed yet. The names
 * are all declared up front so each feature only has to record itself.
 */
export const EVENT_NAMES = [
  "turn_started",
  "turn_ended",
  "duplicate_dropped",
  "burst_merged",
  "route_decided",
  "gate_passed",
  "gate_confirm",
  "guard_block",
  "unknown_tool",
  "pending_action_created",
  "confirmation_received",
  "confirmation_rejected",
  "pending_action_executed",
  "pending_action_expired",
  "tool_ran",
  "handover_started",
  "handover_taken",
  "handover_ended",
  "handover_unanswered",
  "limit_hit",
  "fallback_used",
  "transcribed",
  "knowledge_searched",
  "send_failed",
  "send_unknown",
  "flag_raised",
  "job_ran",
] as const

export type EventName = (typeof EVENT_NAMES)[number]

/** What `deps.events` looks like. The shape evals-agent already records. */
export interface EventSink {
  capture(event: string, props: Record<string, unknown>): void
}

/** Who and what an event is about. Both are absent before either exists. */
export interface EventScope {
  personId?: string | undefined
  turnId?: string | undefined
}

/** One event that could not be recorded. */
export interface EventFailure {
  name: string
  /** Which half failed: the agent's own table, or the injected sink. */
  where: "table" | "sink"
  error: unknown
}

/** One table, as the trace writes to it. */
interface Writes {
  insert(row: Record<string, unknown>): Promise<unknown>
}

/** The part of the store the trace needs. Narrow, so a test can stand in. */
export interface EventStore {
  events: Writes
  toolRuns: Writes
  flags: Writes
  decisions: Writes & {
    /** GATE-3 reads this person's last decisions of one kind. */
    list(
      where: Record<string, string | number | boolean | null>,
      options?: { limit?: number; orderBy?: string; ascending?: boolean },
    ): Promise<{ outcome: string }[]>
  }
}

/** LOOP-8: one tool call, and what became of it (DATA-2 `tool_runs`). */
export interface ToolRunRecord {
  tool: string
  risk: string
  status: ToolRunStatus
  /** What the brain asked for. The whole point of the table (Known K6). */
  args: unknown
  result?: unknown
  error?: string | undefined
  step: number
  durationMs: number
}

/** One decision model call, and what the core did with it (DATA-2). */
export interface DecisionRecord {
  kind: DecisionKind
  /** A RouteDecision or GateDecision reason, depending on the kind. */
  outcome: string
  answers?: Record<string, unknown> | undefined
  model: string
  step?: number | undefined
  durationMs: number
  costUsd: number
}

/** What writing a decision down then tells the caller about GATE-3. */
export interface DecisionRecorded {
  /**
   * True when the decision before this one, for this person and this kind,
   * ended the same way. Two Blocks in a row, or two routing picks below
   * the threshold in a row, is a handover trigger (GATE-3).
   *
   * False when the row could not be written, since a count nobody can read
   * is not a count. The caller gets an answer either way, because a trace
   * that failed must not also stop the turn.
   */
  repeated: boolean
}

export interface EventWriter {
  /** EVT-1: one event, to the table and to the sink. Never throws. */
  record(name: EventName, props?: Record<string, unknown>): Promise<void>
  /** DATA-2: one tool call, with its arguments. Never throws. */
  toolRun(row: ToolRunRecord): Promise<void>
  /** DATA-2: one decision model call, and whether it repeats the last. */
  decision(row: DecisionRecord): Promise<DecisionRecorded>
  /** LEARN-1: a flag, which is a row and the `flag_raised` event. */
  flag(kind: FlagKind, detail?: Record<string, unknown>): Promise<void>
  /** A writer that stamps this person and turn on everything it records. */
  about(scope: EventScope): EventWriter
  /** Every event that could not be recorded, oldest first. */
  readonly failures: readonly EventFailure[]
}

export interface EventsOptions {
  store: EventStore
  clock: Clock
  /** `deps.events`, when the builder gave one. */
  sink?: EventSink | undefined
  /** Told about each failure as it happens, for a glue that logs. */
  onError?: ((failure: EventFailure) => void) | undefined
}

/**
 * A value as a jsonb column can hold it.
 *
 * A tool's result is whatever its handler returned, and that is not always
 * something JSON can carry: a Map, a class instance with a cycle, a Date
 * inside a Set. Losing the whole row over one awkward field would lose the
 * arguments too, which are the reason the row exists, so the field is
 * replaced by a note about itself instead.
 */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return { unrecorded: "this value could not be written as JSON" }
  }
}

export function createEvents(options: EventsOptions): EventWriter {
  const { store, clock, sink, onError } = options
  // Shared by every writer `about` derives, so one list has the lot.
  const failures: EventFailure[] = []

  const failed = (name: string, where: "table" | "sink", error: unknown): void => {
    failures.push({ name, where, error })
    try {
      onError?.({ name, where, error })
    } catch {
      // A broken error handler is not worth breaking a turn over either.
    }
  }

  const build = (scope: EventScope): EventWriter => ({
    failures,

    about: (next: EventScope) => build({ ...scope, ...next }),

    async record(name: EventName, props: Record<string, unknown> = {}): Promise<void> {
      // The table and the sink are independent: either can fail without
      // costing the other its copy of the event.
      try {
        await store.events.insert({
          name,
          props,
          person_id: scope.personId ?? null,
          turn_id: scope.turnId ?? null,
          // TIME-1: the injected clock, not the database's now().
          created_at: clock.now().toISOString(),
        })
      } catch (error) {
        failed(name, "table", error)
      }

      try {
        sink?.capture(name, props)
      } catch (error) {
        failed(name, "sink", error)
      }
    },

    async toolRun(row: ToolRunRecord): Promise<void> {
      try {
        await store.toolRuns.insert({
          person_id: scope.personId ?? null,
          turn_id: scope.turnId ?? null,
          step: row.step,
          tool: row.tool,
          risk: row.risk,
          args: jsonSafe(row.args),
          result: jsonSafe(row.result),
          status: row.status,
          error: row.error ?? null,
          duration_ms: Math.max(0, Math.round(row.durationMs)),
          created_at: clock.now().toISOString(),
        })
      } catch (error) {
        failed("ob_tool_runs", "table", error)
      }
    },

    async decision(row: DecisionRecord): Promise<DecisionRecorded> {
      // Read before the write, so "the one before this" is unambiguous.
      // Reading after would mean telling the newest row apart from its
      // predecessor by a sequence number the insert has not returned yet.
      let previous: string | undefined
      try {
        const last = await store.decisions.list(
          { person_id: scope.personId ?? null, kind: row.kind },
          { orderBy: "seq", ascending: false, limit: 1 },
        )
        previous = last[0]?.outcome
      } catch (error) {
        failed("ob_decisions", "table", error)
      }

      try {
        await store.decisions.insert({
          person_id: scope.personId ?? null,
          turn_id: scope.turnId ?? null,
          step: row.step ?? null,
          kind: row.kind,
          outcome: row.outcome,
          answers: jsonSafe(row.answers ?? {}),
          model: row.model,
          duration_ms: Math.max(0, Math.round(row.durationMs)),
          cost_usd: row.costUsd,
          created_at: clock.now().toISOString(),
        })
      } catch (error) {
        failed("ob_decisions", "table", error)
        return { repeated: false }
      }

      return { repeated: previous === row.outcome }
    },

    async flag(kind: FlagKind, detail: Record<string, unknown> = {}): Promise<void> {
      try {
        await store.flags.insert({
          person_id: scope.personId ?? null,
          turn_id: scope.turnId ?? null,
          kind,
          detail: jsonSafe(detail),
          created_at: clock.now().toISOString(),
        })
      } catch (error) {
        failed("ob_flags", "table", error)
      }
      // EVT-2: the flag is in the trace as well, so a run can be read
      // without joining anything.
      await this.record("flag_raised", { kind, ...detail })
    },
  })

  return build({})
}

/** A writer that records nothing, for a caller that wants no trace. */
export function noEvents(): EventWriter {
  const writer: EventWriter = {
    failures: [],
    about: () => writer,
    record: async () => {},
    toolRun: async () => {},
    decision: async () => ({ repeated: false }),
    flag: async () => {},
  }
  return writer
}
