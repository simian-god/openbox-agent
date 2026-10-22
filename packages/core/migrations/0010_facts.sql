-- DATA-2 and LOOP-7: what the agent knows about a person, apart from what
-- they have said.
--
-- A fact is the difference between an agent that remembers and one that
-- re-reads. "Allergic to peanuts" belongs in a row, not in message
-- nineteen of a conversation the brain may no longer be shown. LOOP-7
-- sends the last 30 messages and no further, so anything that has to
-- survive longer than that has to live here.
--
-- Unique on (agent_id, person_id, key), so remembering the same thing
-- twice updates it rather than leaving two answers for a brain to choose
-- between. The upsert is what `remember` does, and the constraint is what
-- makes it true rather than hoped for.
--
-- `updated_at` is not decoration: PRIV-2's retention sweep deletes facts
-- not updated within the retention period, so the column is what decides
-- whether a fact is still current.

create table if not exists ob_facts (
  id          uuid        primary key default gen_random_uuid(),
  seq         bigserial,
  agent_id    text        not null,
  person_id   uuid        not null references ob_people (id) on delete cascade,

  key         text        not null,
  value       text        not null,
  -- The turn that learned it, for the trace.
  turn_id     uuid        references ob_turns (id) on delete set null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (agent_id, person_id, key)
);

-- LOOP-7 reads every fact about one person on every turn.
create index if not exists ob_facts_person_idx on ob_facts (agent_id, person_id, key);

-- PRIV-2's sweep: facts nobody has touched in a while.
create index if not exists ob_facts_stale_idx on ob_facts (agent_id, updated_at);

alter table ob_facts enable row level security;
