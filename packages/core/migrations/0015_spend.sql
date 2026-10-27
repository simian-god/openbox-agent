-- LIMIT-3: what the agent has spent today.
--
-- One row per agent per day, rather than a sum over the day's turns. The
-- core reaches the database through PostgREST and DATA-3 rules out stored
-- functions, so there is no SUM to call: a total read by adding up rows
-- grows with the day's traffic and has to be capped, and a capped sum on
-- a busy day stops counting and lets the cap through. A spend cap that
-- stops working when spending is heaviest is worse than none.
--
-- `calls` is also the version. Adding to the total is the same conditional
-- update as every other claim here (DATA-4): read the row, then update
-- where `calls` is still what it was. An integer compares exactly, which a
-- float total does not, so two processes cannot both think they won and
-- lose one of the increments.
--
-- `day` is a date in the agent's timezone, as text, because that is what
-- "the current day in the agent's timezone" means and a timestamp would
-- invite the server's own idea of midnight.
create table if not exists ob_spend (
  id          uuid        primary key default gen_random_uuid(),
  agent_id    text        not null,
  day         text        not null,

  usd         numeric(14, 6) not null default 0 check (usd >= 0),
  -- How many calls the total came from, and the version of the row.
  calls       integer     not null default 0 check (calls >= 0),

  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- One row per day, which is what makes the insert race safe: the loser of
-- two inserts reads the winner's row and adds to it.
create unique index if not exists ob_spend_day_idx on ob_spend (agent_id, day);

-- DATA-5: on, with no policies, so only the service key reaches it.
alter table ob_spend enable row level security;
