-- BUILTIN-2 and BUILTIN-3: the task, which is how a conversation that
-- takes several turns remembers where it got to.
--
-- A booking spread over five turns with an unrelated question in the
-- middle is the case this exists for (C14). Without it the only memory of
-- what has been collected is the message history, and a brain re-reading
-- thirty messages to work out whether it ever got a party size will
-- sometimes decide it did.
--
-- `fields` is what has been gathered. `missing` is what the type says is
-- required and is not there yet, and it is written only by code: BUILTIN-2
-- is explicit that the brain never computes it, because a brain that could
-- would eventually say nothing is missing in order to finish.
--
-- `status` carries the active task rather than a separate flag. A person
-- can have several tasks open and exactly one active (section 10), and one
-- column that can only hold one value per person is a simpler thing to
-- keep true than a boolean on several rows.

create table if not exists ob_tasks (
  id           uuid        primary key default gen_random_uuid(),
  seq          bigserial,
  agent_id     text        not null,
  person_id    uuid        not null references ob_people (id) on delete cascade,
  -- The turn that opened it, for the trace.
  turn_id      uuid        references ob_turns (id) on delete set null,

  -- A key of config.taskTypes. Not a check constraint: the types are the
  -- builder's, declared in config, and a migration cannot know them.
  type         text        not null,
  fields       jsonb       not null default '{}'::jsonb,
  -- Computed from the type's required fields on every change (BUILTIN-2).
  missing      text[]      not null default '{}',

  status       text        not null default 'open'
               check (status in ('open', 'active', 'done', 'cancelled', 'expired')),
  -- BUILTIN-3: idle expiry, pushed out by every change.
  expires_at   timestamptz not null,
  closed_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- LOOP-7 reads this on every turn: this person's open tasks, newest first.
create index if not exists ob_tasks_person_idx
  on ob_tasks (agent_id, person_id, seq)
  where status in ('open', 'active');

-- BUILTIN-3's sweep, if a scheduled job was ever lost.
create index if not exists ob_tasks_expiry_idx
  on ob_tasks (agent_id, expires_at)
  where status in ('open', 'active');

alter table ob_tasks enable row level security;
