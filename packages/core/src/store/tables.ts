// The shape of the rows in the core tables created by migration 0001.
// One type per table, matching the columns exactly.

export const CORE_TABLES = [
  "ob_people",
  "ob_person_leases",
  "ob_versions",
  "ob_turns",
  "ob_inbox",
  "ob_messages",
  "ob_outbox",
  "ob_jobs",
  "ob_events",
  "ob_tool_runs",
  "ob_decisions",
  "ob_flags",
  "ob_pending_actions",
] as const

export type CoreTable = (typeof CORE_TABLES)[number]

export type PersonRole = "end_user" | "operator"
export type InboxStatus = "pending" | "merged" | "done" | "failed"
export type MessageDirection = "inbound" | "outbound"
export type MessageAuthor = "person" | "agent" | "operator" | "notice"
export type OutboxKind = "reply" | "proactive" | "operator_alert" | "confirm"
/** `unknown` is not a kind of failure: the send threw, so nobody knows. */
export type OutboxStatus = "queued" | "sending" | "sent" | "failed" | "unknown"
export type JobStatus = "queued" | "running" | "done" | "failed"
/**
 * CONF-1 and CONF-5. `pending` is waiting on the person, `confirmed` is
 * claimed and about to run, `executed` ran. Two states rather than one,
 * because the claim is what stops a second tap running it twice.
 */
export type PendingActionStatus =
  | "pending"
  | "confirmed"
  | "executed"
  | "failed"
  | "cancelled"
  | "expired"

/** DATA-2. `pending` is an irreversible call waiting on a person's confirm. */
export type ToolRunStatus = "ok" | "error" | "blocked" | "needs_confirmation" | "pending"
/** What the decision model was asked about. */
export type DecisionKind = "route" | "gate" | "frustration" | "wants_human"
/**
 * LEARN-1's kinds, as the Spec's own table lists them. A test holds this
 * list to that table, so neither can drift from the other.
 *
 * T3.5 raises `gate_block` and `low_confidence`. The rest are declared up
 * front so each feature only has to raise its own, and so the migration's
 * check constraint is written once.
 */
export const FLAG_KINDS = [
  "handover",
  "gate_block",
  "low_confidence",
  "tool_error",
  "unknown_tool",
  "frustration",
  "step_cap",
  "confirmation_rejected",
  "operator",
] as const

export type FlagKind = (typeof FLAG_KINDS)[number]

export interface PersonRow {
  id: string
  agent_id: string
  channel: string
  channel_user_id: string
  role: PersonRole
  display_name: string | null
  language: string | null
  blocked: boolean
  opted_out: boolean
  notice_shown_at: string | null
  created_at: string
  updated_at: string
}

/** LOOP-2: who is handling a person, and until when. */
export interface LeaseRow {
  id: string
  agent_id: string
  person_id: string
  /** Which process holds it. Null means it has never been claimed. */
  owner: string | null
  /** In the past means free. The epoch is how a fresh row starts. */
  expires_at: string
  created_at: string
}

export interface VersionRow {
  id: string
  agent_id: string
  hash: string
  first_seen_at: string
}

export interface TurnRow {
  id: string
  agent_id: string
  person_id: string
  version_id: string | null
  brains: string[]
  steps: number
  cost_usd: number
  latency_ms: number | null
  outcome: string | null
  started_at: string
  ended_at: string | null
}

export interface InboxRow {
  id: string
  /** Insert order, which is arrival order (LOOP-3). */
  seq: number
  agent_id: string
  person_id: string
  channel_message_id: string
  text: string | null
  media: unknown
  action: unknown
  status: InboxStatus
  turn_id: string | null
  received_at: string
  created_at: string
}

export interface MessageRow {
  id: string
  /** Insert order, which is the order the conversation happened in. */
  seq: number
  agent_id: string
  person_id: string
  turn_id: string | null
  direction: MessageDirection
  author: MessageAuthor
  text: string | null
  transcript: string | null
  media_ref: string | null
  channel: string | null
  created_at: string
}

/** LOOP-11: one outgoing message, written down before it is sent. */
export interface OutboxRow {
  id: string
  /** Insert order, which is the order a person must receive things in. */
  seq: number
  agent_id: string
  person_id: string
  turn_id: string | null
  kind: OutboxKind
  channel: string
  channel_user_id: string
  /** The Outbound minus the address: text, buttons, template, file. */
  payload: Record<string, unknown>
  status: OutboxStatus
  attempts: number
  idempotency_key: string
  not_before: string
  urgent: boolean
  channel_message_id: string | null
  error: string | null
  last_attempt_at: string | null
  created_at: string
}

/** Anything the agent does at a time rather than in answer to a message. */
export interface JobRow {
  id: string
  seq: number
  agent_id: string
  kind: string
  payload: Record<string, unknown>
  status: JobStatus
  run_at: string
  attempts: number
  /** Null when the job needs no key. Unique per agent when it has one. */
  dedupe_key: string | null
  lease_owner: string | null
  lease_expires_at: string | null
  error: string | null
  last_run_at: string | null
  created_at: string
}

export interface EventRow {
  id: string
  /** Insert order, which is the order the trace happened in (EVT-1). */
  seq: number
  agent_id: string
  name: string
  props: Record<string, unknown>
  person_id: string | null
  turn_id: string | null
  created_at: string
}

/**
 * One tool call: what it was given, what came back, and what became of it.
 *
 * A call that never reached a handler still gets a row, because being
 * blocked by the gate is as much a thing that happened as running.
 */
export interface ToolRunRow {
  id: string
  seq: number
  agent_id: string
  person_id: string
  turn_id: string | null
  step: number
  tool: string
  risk: string
  args: unknown
  result: unknown
  status: ToolRunStatus
  error: string | null
  duration_ms: number
  created_at: string
}

/** One decision model call, and what the core did with the answer. */
export interface DecisionRow {
  id: string
  seq: number
  agent_id: string
  person_id: string
  turn_id: string | null
  step: number | null
  kind: DecisionKind
  /** A RouteDecision or GateDecision reason, depending on the kind. */
  outcome: string
  answers: Record<string, unknown>
  model: string
  duration_ms: number
  cost_usd: number
  created_at: string
}

/** LEARN-1: something about this turn worth a builder's attention. */
export interface FlagRow {
  id: string
  seq: number
  agent_id: string
  person_id: string
  turn_id: string | null
  kind: FlagKind
  detail: Record<string, unknown>
  reviewed_at: string | null
  review_outcome: string | null
  created_at: string
}

/** CONF-1: an irreversible call, waiting for the person who asked for it. */
export interface PendingActionRow {
  id: string
  seq: number
  agent_id: string
  person_id: string
  turn_id: string | null
  /** T4.2 fills this in. Null until tasks exist. */
  task_id: string | null
  tool: string
  args: unknown
  /** CONF-4: a confirmation is only for the call that was shown. */
  args_hash: string
  /** What the person was asked to confirm, as they were shown it. */
  summary: string
  /** CONF-2's fallback for a channel with no buttons. Four digits. */
  code: string
  status: PendingActionStatus
  expires_at: string
  decided_at: string | null
  executed_at: string | null
  result: unknown
  error: string | null
  created_at: string
}

/** Maps a table name to its row type. */
export interface CoreRows {
  ob_people: PersonRow
  ob_person_leases: LeaseRow
  ob_versions: VersionRow
  ob_turns: TurnRow
  ob_inbox: InboxRow
  ob_messages: MessageRow
  ob_outbox: OutboxRow
  ob_jobs: JobRow
  ob_events: EventRow
  ob_tool_runs: ToolRunRow
  ob_decisions: DecisionRow
  ob_flags: FlagRow
  ob_pending_actions: PendingActionRow
}

/** What a caller supplies when inserting: no id, no agent_id, no defaults. */
export type Insert<T> = Omit<T, "id" | "agent_id" | "created_at">
