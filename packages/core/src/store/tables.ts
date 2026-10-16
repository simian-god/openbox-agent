// The shape of the rows in the core tables created by migration 0001.
// One type per table, matching the columns exactly.

export const CORE_TABLES = [
  "ob_people",
  "ob_versions",
  "ob_turns",
  "ob_inbox",
  "ob_messages",
  "ob_events",
] as const

export type CoreTable = (typeof CORE_TABLES)[number]

export type PersonRole = "end_user" | "operator"
export type InboxStatus = "pending" | "merged" | "done" | "failed"
export type MessageDirection = "inbound" | "outbound"
export type MessageAuthor = "person" | "agent" | "operator" | "notice"

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

export interface EventRow {
  id: string
  agent_id: string
  name: string
  props: Record<string, unknown>
  person_id: string | null
  turn_id: string | null
  created_at: string
}

/** Maps a table name to its row type. */
export interface CoreRows {
  ob_people: PersonRow
  ob_versions: VersionRow
  ob_turns: TurnRow
  ob_inbox: InboxRow
  ob_messages: MessageRow
  ob_events: EventRow
}

/** What a caller supplies when inserting: no id, no agent_id, no defaults. */
export type Insert<T> = Omit<T, "id" | "agent_id" | "created_at">
