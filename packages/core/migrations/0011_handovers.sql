-- HAND-1 to HAND-3: the handover, which is how a conversation stops being
-- the agent's and becomes a person's.
--
-- It is a row rather than a flag on the person for two reasons. A handover
-- has a history worth keeping: why it opened, who took it, when each of
-- those happened. And it is the thing two operators race for (HAND-3), so
-- it needs a status that can be claimed with one conditional update the
-- way every other claim in this core is done (DATA-4).
--
-- `reason` is the trigger that opened it, from one short list, because the
-- digest counts them and free text cannot be counted. What the brain or
-- the person actually said goes in `detail`.
--
-- `summary` is HAND-2's three lines, written by the brain. Nullable on
-- purpose: an alert must go out even when every brain is down, because the
-- person has already been told somebody will reply.

create table if not exists ob_handovers (
  id            uuid        primary key default gen_random_uuid(),
  seq           bigserial,
  agent_id      text        not null,
  person_id     uuid        not null references ob_people (id) on delete cascade,
  -- The turn that triggered it. Null when an operator started it.
  turn_id       uuid        references ob_turns (id) on delete set null,

  status        text        not null default 'waiting'
                check (status in ('waiting', 'active', 'unanswered', 'closed')),

  -- HAND-1's triggers, named so they can be counted.
  reason        text        not null
                check (reason in (
                  'escalate',
                  'wants_human',
                  'gate_block_repeat',
                  'low_confidence_repeat',
                  'tool_failed_repeat',
                  'spend_cap',
                  'step_cap',
                  'brains_failed',
                  'operator'
                )),
  -- What was said, or which tool kept failing. For the operator to read.
  detail        text,
  -- HAND-2: the brain's three lines. Null when no brain could write them.
  summary       text,

  -- HAND-3: whoever took it, which is a person row with the operator role.
  operator_id   uuid        references ob_people (id) on delete set null,
  -- Why it ended: `resume`, `idle`, or an operator's name later on.
  ended_reason  text,

  opened_at     timestamptz not null default now(),
  taken_at      timestamptz,
  -- HAND-6's hourly repeat, so a reminder is not sent twice.
  alerted_at    timestamptz,
  ended_at      timestamptz,
  created_at    timestamptz not null default now()
);

-- HAND-1 and HAND-2: one open handover per person, enforced here rather
-- than by looking first. Two triggers in one turn, or two processes at
-- once, must not open two: the person would be told twice and the
-- operators would see the same conversation under two rows.
create unique index if not exists ob_handovers_one_open_idx
  on ob_handovers (agent_id, person_id)
  where status in ('waiting', 'active', 'unanswered');

-- What LOOP-5 step 5 asks on every turn: is this person in a handover.
create index if not exists ob_handovers_person_idx
  on ob_handovers (agent_id, person_id, seq);

-- HAND-3 and HAND-6: what an operator is offered, and what the sweep
-- looks for, oldest first.
create index if not exists ob_handovers_open_idx
  on ob_handovers (agent_id, status, seq)
  where status in ('waiting', 'active', 'unanswered');

alter table ob_handovers enable row level security;
