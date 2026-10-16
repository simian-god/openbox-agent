-- Conversation order cannot rest on a timestamp.
--
-- Two rows written in the same instant tie, and the order they come back
-- in is then undefined, which can put a reply before the question it
-- answers. It happens whenever the clock is frozen, which is how every
-- test runs, and on a fast machine it can happen in production too.
--
-- `seq` is assigned by the database in insert order, so it is the order
-- things actually happened. created_at stays, since it is what the agent
-- and the person care about.

alter table ob_messages add column if not exists seq bigserial;
alter table ob_inbox    add column if not exists seq bigserial;

-- History is read newest first for one person, then reversed.
create index if not exists ob_messages_seq_idx on ob_messages (agent_id, person_id, seq desc);

-- LOOP-3 takes a person's pending rows in arrival order.
create index if not exists ob_inbox_seq_idx on ob_inbox (agent_id, person_id, seq);
