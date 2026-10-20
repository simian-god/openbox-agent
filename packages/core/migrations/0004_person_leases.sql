-- LOOP-2: which process is handling a person, and until when.
--
-- A lease row exists for every person, and is created unclaimed: expires_at
-- in the past means nobody owns them. Claiming is then always the same
-- single conditional update DATA-4 asks for, rather than sometimes an
-- insert and sometimes an update:
--
--   update ob_person_leases set owner = ?, expires_at = ?
--    where agent_id = ? and person_id = ? and expires_at < ?
--   returning *
--
-- Exactly one of several workers can win that, because Postgres takes a row
-- lock for the update and the loser then sees the winner's expires_at.

create table if not exists ob_person_leases (
  id          uuid        primary key default gen_random_uuid(),
  agent_id    text        not null,
  person_id   uuid        not null references ob_people (id) on delete cascade,
  -- Which process holds it. Null means the row has never been claimed.
  owner       text,
  -- The epoch means unclaimed, so the claim never has to treat null as a
  -- special case.
  expires_at  timestamptz not null default 'epoch',
  created_at  timestamptz not null default now(),

  unique (agent_id, person_id)
);

-- Every person that already exists gets a free lease, so no one can be
-- stuck unclaimable after an upgrade.
insert into ob_person_leases (agent_id, person_id)
select agent_id, id from ob_people
on conflict (agent_id, person_id) do nothing;

-- The worker's own access path: people whose lease is free.
create index if not exists ob_person_leases_free_idx
  on ob_person_leases (agent_id, expires_at);

-- The worker looks for the oldest waiting messages across all people, which
-- the index from migration 0001 cannot serve: that one leads with person_id.
-- Partial, so it only ever holds the rows still waiting, however large the
-- table grows.
create index if not exists ob_inbox_pending_order_idx
  on ob_inbox (agent_id, seq)
  where status = 'pending';

-- A turn takes every row a person has waiting, in arrival order, and a
-- crash leaves rows mid turn that have to be findable again.
create index if not exists ob_inbox_person_status_idx
  on ob_inbox (agent_id, person_id, status, seq);

alter table ob_person_leases enable row level security;
