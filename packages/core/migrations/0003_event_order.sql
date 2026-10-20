-- The event trace is a sequence, so it needs a sequence.
--
-- Same reason as migration 0002. EVT-1 calls `ob_events` the full trace of
-- a turn, and a trace whose rows can come back in any order is not one.
-- Several events in one turn share an instant, and under a frozen clock
-- every event does, so created_at cannot order them.

alter table ob_events add column if not exists seq bigserial;

-- Reading the whole trace for one agent, oldest first.
create index if not exists ob_events_seq_idx on ob_events (agent_id, seq);

-- Reading one turn's trace, which is what a review looks at. This replaces
-- migration 0001's (agent_id, turn_id) index, which it starts with, so
-- keeping both would only cost every insert twice.
create index if not exists ob_events_turn_seq_idx on ob_events (agent_id, turn_id, seq);
drop index if exists ob_events_turn_idx;
