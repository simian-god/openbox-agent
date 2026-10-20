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
import type { Clock } from "../testing/clock.ts"

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

/** The part of the store events need. Narrow, so a test can stand in. */
export interface EventStore {
  events: { insert(row: Record<string, unknown>): Promise<unknown> }
}

export interface EventWriter {
  /** EVT-1: one event, to the table and to the sink. Never throws. */
  record(name: EventName, props?: Record<string, unknown>): Promise<void>
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
  })

  return build({})
}

/** A writer that records nothing, for a caller that wants no trace. */
export function noEvents(): EventWriter {
  const writer: EventWriter = {
    failures: [],
    about: () => writer,
    record: async () => {},
  }
  return writer
}
