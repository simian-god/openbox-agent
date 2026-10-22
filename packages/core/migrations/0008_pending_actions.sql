-- CONF-1: the pending action, which is how an irreversible call waits for
-- the person who asked for it.
--
-- The whole point of the table is that the decision to act and the act are
-- two separate, durable things. A brain deciding to charge a card is not a
-- charge. The row in between is what the person confirms, and it holds
-- everything the confirmation has to be checked against: who it was for,
-- what the arguments were, a hash of those arguments, and when it stops
-- being valid.
--
-- `args_hash` is there for CONF-4's last rule. A confirmation is only for
-- the call it was shown: if the brain changes its mind about the party size
-- after the person has been asked, the old confirm must not run the new
-- call. Hashing the arguments is how the row notices.
--
-- `code` is CONF-2's fallback for a channel with no buttons. It is not a
-- password: it is checked together with the person it belongs to, so
-- guessing it from another account buys nothing.

create table if not exists ob_pending_actions (
  id           uuid        primary key default gen_random_uuid(),
  seq          bigserial,
  agent_id     text        not null,
  person_id    uuid        not null references ob_people (id) on delete cascade,
  -- The turn that decided to do this, for the trace.
  turn_id      uuid        references ob_turns (id) on delete set null,
  -- CONF-1 and CONF-6: the task this belongs to. No foreign key yet,
  -- because ob_tasks arrives with T4.2. A column now, so an action created
  -- before then is not re-migrated later.
  task_id      uuid,

  tool         text        not null,
  args         jsonb       not null default '{}'::jsonb,
  -- A hash of `args`, so a confirmation is only ever for the call that was
  -- actually shown to the person (CONF-4).
  args_hash    text        not null,
  -- CONF-1: what the person is asked to confirm, from the tool's own
  -- confirmSummary. Stored rather than recomputed, so the record says what
  -- they were shown and not what the code would say today.
  summary      text        not null,
  code         text        not null,

  status       text        not null default 'pending'
               check (status in ('pending', 'confirmed', 'executed', 'failed', 'cancelled', 'expired')),
  expires_at   timestamptz not null,

  -- When the person decided, and when the handler actually ran. Two
  -- timestamps because CONF-5 makes them two steps: the claim is what
  -- stops a second tap, and the run happens after it.
  decided_at   timestamptz,
  executed_at  timestamptz,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now()
);

-- The one a confirmation looks for: this person's pending action.
create index if not exists ob_pending_actions_person_idx
  on ob_pending_actions (agent_id, person_id, seq)
  where status = 'pending';

-- What the expiry job sweeps, if a scheduled job was ever lost.
create index if not exists ob_pending_actions_expiry_idx
  on ob_pending_actions (agent_id, expires_at)
  where status = 'pending';

-- CONF-6: every action on one task, so a new one can cancel the old.
create index if not exists ob_pending_actions_task_idx
  on ob_pending_actions (agent_id, task_id, seq);

alter table ob_pending_actions enable row level security;
