-- The first core tables (DATA-2): people, versions, turns, inbox, messages
-- and events. The rest of DATA-2's tables arrive with the features that
-- use them.
--
-- Plain DDL only: tables, keys, unique and check constraints, indexes
-- (DATA-3). No triggers, no stored functions, no extensions. gen_random_uuid
-- is built into Postgres 13 and later, so it needs none.
--
-- Every table carries agent_id (DATA-1) and has RLS switched on with no
-- policies (DATA-5), so only the service key the agent runs with can read
-- or write it.

-- Which migrations have run. Schema bookkeeping, not agent data, so this is
-- the one core table with no agent_id: the schema is shared by every agent
-- pointed at this database.
create table if not exists ob_migrations (
  name        text primary key,
  checksum    text        not null,
  applied_at  timestamptz not null default now()
);

-- ROLE-1: role comes only from here, never from a message.
create table if not exists ob_people (
  id               uuid        primary key default gen_random_uuid(),
  agent_id         text        not null,
  channel          text        not null,
  channel_user_id  text        not null,
  role             text        not null default 'end_user'
                   check (role in ('end_user', 'operator')),
  display_name     text,
  language         text,
  blocked          boolean     not null default false,
  opted_out        boolean     not null default false,
  notice_shown_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (agent_id, channel, channel_user_id)
);

-- LEARN-2: the hash of prompt, tools, config and core version that a turn
-- ran under, with when it was first seen.
create table if not exists ob_versions (
  id             uuid        primary key default gen_random_uuid(),
  agent_id       text        not null,
  hash           text        not null,
  first_seen_at  timestamptz not null default now(),

  unique (agent_id, hash)
);

-- LOOP-11: what a turn recorded when it ended.
create table if not exists ob_turns (
  id          uuid        primary key default gen_random_uuid(),
  agent_id    text        not null,
  person_id   uuid        not null references ob_people (id) on delete cascade,
  version_id  uuid        references ob_versions (id),
  brains      text[]      not null default '{}',
  steps       integer     not null default 0 check (steps >= 0),
  cost_usd    numeric(12, 6) not null default 0 check (cost_usd >= 0),
  latency_ms  integer     check (latency_ms >= 0),
  outcome     text,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);

create index if not exists ob_turns_person_idx on ob_turns (agent_id, person_id, started_at desc);

-- Every incoming message, before and after it is handled.
create table if not exists ob_inbox (
  id                  uuid        primary key default gen_random_uuid(),
  agent_id            text        not null,
  person_id           uuid        not null references ob_people (id) on delete cascade,
  channel_message_id  text        not null,
  text                text,
  media               jsonb,
  action              jsonb,
  status              text        not null default 'pending'
                      check (status in ('pending', 'merged', 'done', 'failed')),
  turn_id             uuid        references ob_turns (id) on delete set null,
  received_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),

  -- The same webhook delivered twice is one row, not two (C13).
  unique (agent_id, person_id, channel_message_id)
);

create index if not exists ob_inbox_pending_idx
  on ob_inbox (agent_id, person_id, received_at)
  where status = 'pending';

-- The conversation itself, in both directions.
create table if not exists ob_messages (
  id          uuid        primary key default gen_random_uuid(),
  agent_id    text        not null,
  person_id   uuid        not null references ob_people (id) on delete cascade,
  turn_id     uuid        references ob_turns (id) on delete set null,
  direction   text        not null check (direction in ('inbound', 'outbound')),
  author      text        not null
              check (author in ('person', 'agent', 'operator', 'notice')),
  text        text,
  transcript  text,
  media_ref   text,
  channel     text,
  created_at  timestamptz not null default now()
);

create index if not exists ob_messages_person_idx
  on ob_messages (agent_id, person_id, created_at desc);

-- EVT-1: the full trace. person_id and turn_id are nullable because some
-- events happen before either exists.
create table if not exists ob_events (
  id          uuid        primary key default gen_random_uuid(),
  agent_id    text        not null,
  name        text        not null,
  props       jsonb       not null default '{}'::jsonb,
  person_id   uuid        references ob_people (id) on delete set null,
  turn_id     uuid        references ob_turns (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists ob_events_name_idx on ob_events (agent_id, name, created_at desc);
create index if not exists ob_events_turn_idx on ob_events (agent_id, turn_id);

-- DATA-5. No policies: a table with RLS on and no policy is readable and
-- writable only by a role that bypasses RLS, which is the service key the
-- agent runs with. The anon key that ships in a frontend gets nothing.
alter table ob_migrations enable row level security;
alter table ob_people     enable row level security;
alter table ob_versions   enable row level security;
alter table ob_turns      enable row level security;
alter table ob_inbox      enable row level security;
alter table ob_messages   enable row level security;
alter table ob_events     enable row level security;
