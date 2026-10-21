-- The three tables the gate needs (DATA-2): what every tool call was given
-- and what became of it, every decision model call, and the flags a turn
-- raises about itself.
--
-- `ob_events` already says a tool ran. It does not say what the tool was
-- given, which is the one thing a review of a bad call needs most, and the
-- one thing an evals assertion of the form "must call X with these
-- arguments" cannot do without. That was Known K6, and `ob_tool_runs`
-- closes it.
--
-- `ob_decisions` is the record of what was asked of the decision model and
-- what came back. It is also how GATE-3 is answered: "two blocks in a row
-- for the same person" is a question about this table, which is why the
-- outcome is a column of its own rather than something to be dug out of
-- the answers.

create table if not exists ob_tool_runs (
  id            uuid        primary key default gen_random_uuid(),
  -- Insert order, which is the order the calls happened in within a turn.
  seq           bigserial,
  agent_id      text        not null,
  person_id     uuid        not null references ob_people (id) on delete cascade,
  turn_id       uuid        references ob_turns (id) on delete set null,
  -- Which step of the turn called it (LOOP-8).
  step          integer     not null check (step >= 1),

  tool          text        not null,
  risk          text        not null check (risk in ('read', 'write', 'irreversible')),
  -- What the brain asked for, after the schema checked it (LOOP-8 step 6).
  -- Not an object: a tool takes an object today, but a record of what was
  -- asked should not be the thing that refuses to hold what was asked.
  args          jsonb,
  result        jsonb,

  status        text        not null
                check (status in ('ok', 'error', 'blocked', 'needs_confirmation', 'pending')),
  error         text,
  duration_ms   integer     not null default 0 check (duration_ms >= 0),
  created_at    timestamptz not null default now()
);

-- Everything one turn called, in order, which is how a review reads it.
create index if not exists ob_tool_runs_turn_idx on ob_tool_runs (agent_id, turn_id, seq);

-- One person's calls, which is what LOOP-10's repeat rule will ask for.
create index if not exists ob_tool_runs_person_idx on ob_tool_runs (agent_id, person_id, seq);

create table if not exists ob_decisions (
  id            uuid        primary key default gen_random_uuid(),
  seq           bigserial,
  agent_id      text        not null,
  person_id     uuid        not null references ob_people (id) on delete cascade,
  turn_id       uuid        references ob_turns (id) on delete set null,
  step          integer     check (step >= 1),

  kind          text        not null
                check (kind in ('route', 'gate', 'frustration', 'wants_human')),
  -- What the core did with the answer. Its meaning depends on the kind:
  -- routing records a RouteDecision reason, the gate a GateDecision one.
  -- Deliberately not a check constraint: the two sets have nothing in
  -- common and more kinds arrive in later milestones, so a constraint here
  -- would be a migration every time one does.
  outcome       text        not null,
  -- The answers as the adapter returned them, so a tuned threshold can be
  -- replayed against what the model actually said (LEARN-5).
  answers       jsonb       not null default '{}'::jsonb,
  model         text        not null,
  duration_ms   integer     not null default 0 check (duration_ms >= 0),
  cost_usd      numeric(12, 6) not null default 0 check (cost_usd >= 0),
  created_at    timestamptz not null default now()
);

-- GATE-3's access path: this person's last few decisions of one kind,
-- newest first, which is what "two in a row" reads.
create index if not exists ob_decisions_person_kind_idx
  on ob_decisions (agent_id, person_id, kind, seq);

create index if not exists ob_decisions_turn_idx on ob_decisions (agent_id, turn_id, seq);

create table if not exists ob_flags (
  id              uuid        primary key default gen_random_uuid(),
  seq             bigserial,
  agent_id        text        not null,
  person_id       uuid        not null references ob_people (id) on delete cascade,
  turn_id         uuid        references ob_turns (id) on delete set null,

  -- LEARN-1's list in full, so each kind only has to be raised rather than
  -- migrated for. T3.5 raises gate_block and low_confidence; the rest
  -- arrive with the features that notice them.
  kind            text        not null
                  check (kind in (
                    'handover',
                    'gate_block',
                    'low_confidence',
                    'tool_error',
                    'unknown_tool',
                    'frustration',
                    'step_cap',
                    'confirmation_rejected',
                    'operator'
                  )),
  detail          jsonb       not null default '{}'::jsonb,

  -- LEARN-4: the review marks a flag done and says what came of it.
  reviewed_at     timestamptz,
  review_outcome  text,
  created_at      timestamptz not null default now()
);

-- What the review command reads: unreviewed flags, oldest first. Partial,
-- so it holds only the backlog however long the agent has been running.
create index if not exists ob_flags_unreviewed_idx
  on ob_flags (agent_id, seq)
  where reviewed_at is null;

create index if not exists ob_flags_person_idx on ob_flags (agent_id, person_id, seq);

alter table ob_tool_runs enable row level security;
alter table ob_decisions enable row level security;
alter table ob_flags enable row level security;
