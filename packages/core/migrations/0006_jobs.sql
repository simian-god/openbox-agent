-- The job table (DATA-2), and the index the recovery sweep needs.
--
-- A job is anything the agent does at a time rather than in answer to a
-- message: reminders (PRO-1), expiries, retention, the weekly digest. None
-- of those exist yet. What exists is the loop that will run them, and the
-- first thing worth running: picking up turns a dead process left behind.
--
-- `dedupe_key` is nullable and unique per agent. Postgres allows many nulls
-- in a unique index, so a job that needs no key does not need a made up
-- one, and PRO-1's "scheduling the same reminder twice is a no op" falls
-- out of the constraint rather than out of a prior read.

create table if not exists ob_jobs (
  id                 uuid        primary key default gen_random_uuid(),
  -- Insert order, to break ties between jobs due at the same instant.
  seq                bigserial,
  agent_id           text        not null,
  kind               text        not null,
  payload            jsonb       not null default '{}'::jsonb,

  status             text        not null default 'queued'
                     check (status in ('queued', 'running', 'done', 'failed')),
  -- When it may run. Moved out by the backoff after a failure.
  run_at             timestamptz not null default now(),
  attempts           integer     not null default 0 check (attempts >= 0),
  dedupe_key         text,

  -- Which process is running it, and until when. A job outlives the
  -- process that claimed it, so a claim that is never finished has to be
  -- findable: same reasoning as a person's lease.
  lease_owner        text,
  lease_expires_at   timestamptz,

  error              text,
  last_run_at        timestamptz,
  created_at         timestamptz not null default now(),

  unique (agent_id, dedupe_key)
);

-- The job loop's own access path: what is due, oldest first.
create index if not exists ob_jobs_due_idx
  on ob_jobs (agent_id, run_at, seq)
  where status = 'queued';

-- Jobs a process claimed and never finished.
create index if not exists ob_jobs_abandoned_idx
  on ob_jobs (agent_id, lease_expires_at)
  where status = 'running';

-- The recovery sweep looks for messages a turn took and never finished
-- with, across every person. Migration 0004's index leads with person_id,
-- so it cannot serve that. Partial, so it holds only the rows mid turn,
-- which is a handful at any moment however large the inbox grows.
create index if not exists ob_inbox_merged_idx
  on ob_inbox (agent_id, seq)
  where status = 'merged';

alter table ob_jobs enable row level security;
