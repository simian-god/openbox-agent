-- LOOP-11: the reply goes to the outbox, not straight down the wire.
--
-- A reply the core has decided on is a fact. The channel being up is not.
-- Writing it down first means a send can be retried, can be seen to have
-- failed, and cannot be silently lost because a webhook handler returned.
--
-- The statuses are DATA-2's: queued, sending, sent, failed, unknown.
-- `unknown` is the one that matters and is not a kind of failure: the send
-- threw, so the message may well have arrived. Sending it again would say
-- it twice, which is worse than not knowing.

create table if not exists ob_outbox (
  id                  uuid        primary key default gen_random_uuid(),
  -- Insert order, which is the order a person must receive things in.
  seq                 bigserial,
  agent_id            text        not null,
  person_id           uuid        not null references ob_people (id) on delete cascade,
  turn_id             uuid        references ob_turns (id) on delete set null,

  kind                text        not null
                      check (kind in ('reply', 'proactive', 'operator_alert', 'confirm')),
  -- Where it goes. Addressed when queued, so a person's channel changing
  -- later cannot redirect a message already decided on.
  channel             text        not null,
  channel_user_id     text        not null,
  -- The Outbound, minus the address: text, buttons, template, file.
  payload             jsonb       not null default '{}'::jsonb,

  status              text        not null default 'queued'
                      check (status in ('queued', 'sending', 'sent', 'failed', 'unknown')),
  attempts            integer     not null default 0 check (attempts >= 0),
  -- The same key is never sent twice, however many times it is queued.
  idempotency_key     text        not null,
  -- When it may next be tried. Moved out by the backoff after a refusal,
  -- and by quiet hours once PRO-3 lands.
  not_before          timestamptz not null default now(),
  urgent              boolean     not null default false,

  -- What the channel said, either way.
  channel_message_id  text,
  error               text,
  last_attempt_at     timestamptz,
  created_at          timestamptz not null default now(),

  unique (agent_id, idempotency_key)
);

-- The outbox worker's access path: what is due, oldest first. Partial, so
-- it only ever holds the rows still to go however large the table grows.
create index if not exists ob_outbox_due_idx
  on ob_outbox (agent_id, not_before, seq)
  where status = 'queued';

-- One person's messages in order, which is how they must go out.
create index if not exists ob_outbox_person_idx on ob_outbox (agent_id, person_id, seq);

-- Everything a turn sent, which is what API-2 waits for.
create index if not exists ob_outbox_turn_idx on ob_outbox (agent_id, turn_id);

alter table ob_outbox enable row level security;
