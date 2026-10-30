-- The agent's own tables. Core tables are the core's and are applied
-- first (PKG-4), so nothing here needs to create them.
--
-- DATA-5: row level security goes on every table, in the same migration
-- that creates it. `openbox migrate` reads the schema afterwards and
-- refuses to finish if any table has it off, so a forgotten line is
-- caught on the first run rather than by somebody reading the file later.
-- No policies are added, which means nothing but the service key can read
-- it: on Supabase the anon key is public, and a table with security off
-- is a table the internet can read.
--
-- Two more rules this file follows:
--
-- Every row carries `agent_id` (DATA-1), because one database can hold
-- several agents and a query that forgets the filter reads another
-- agent's data.
--
-- A person is referenced by `ob_people (id)` with `on delete cascade`, so
-- erasing a person takes their rows with them (PRIV-3) rather than
-- leaving them behind in a table nobody thought to clear.
--
-- The table below is a sample that applies as it stands, so a first
-- `openbox migrate` works. Rename it and give it real columns.

-- {{agent_table_name}}: rename to what it holds, like `bookings` or
-- `orders`. One table per thing the agent keeps.
create table if not exists agent_records (
  id          uuid        primary key default gen_random_uuid(),
  -- A plain counter, for reading rows back in the order they arrived.
  -- A timestamp is not an order: two rows can share a millisecond.
  seq         bigserial,
  agent_id    text        not null,
  person_id   uuid        not null references ob_people (id) on delete cascade,

  -- {{agent_columns}}: the builder's own fields, in real columns. `jsonb`
  -- is here so the sample is useful on its own, and a field that is
  -- always present and always queried belongs in a column of its own.
  status      text        not null default 'open',
  details     jsonb       not null default '{}'::jsonb,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The index every read needs, because every read filters on the agent.
create index if not exists agent_records_agent_person_idx
  on agent_records (agent_id, person_id, seq desc);

-- DATA-5. Not optional, and not a policy: nothing but the service key
-- reads this table.
alter table agent_records enable row level security;
