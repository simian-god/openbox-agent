-- HAND-8 and LEARN-6: what a colleague knew that the agent did not.
--
-- A handover is the agent failing to answer something and a person
-- answering it instead. That exchange is the most valuable thing in the
-- whole system: it is a real question, with a real answer, from someone
-- who knows. Thrown away, the agent fails the same question next week.
--
-- Nothing here is searchable (LEARN-6). A row arrives as a `candidate`
-- and an operator has to approve it, because the words were typed to one
-- person in one conversation and may be wrong for everyone else: a price
-- for one table, a promise about one booking, an apology. The approval
-- tools and the index are T8.4.
--
-- `question_message_id` is unique, so the pair is captured once however
-- many times a relay runs. It is also what says which question an answer
-- answered, which nothing else would record.
create table if not exists ob_knowledge (
  id            uuid        primary key default gen_random_uuid(),
  seq           bigserial,
  agent_id      text        not null,

  question      text        not null,
  answer        text        not null,

  status        text        not null default 'candidate'
                check (status in ('candidate', 'approved', 'rejected')),
  -- Where it came from. Only handovers write here today; KNOW-1's files
  -- are not entries, they are chunks loaded at start.
  source        text        not null default 'handover'
                check (source in ('handover', 'operator')),

  handover_id   uuid        references ob_handovers (id) on delete set null,
  -- PRIV-3: erasing a person deletes what they said, and a candidate is
  -- their words. Cascade, so erasure cannot leave a person's question
  -- behind in a table PRIV-3's list does not name. What should happen to
  -- an entry already approved is the builder's call at M9; nothing can be
  -- approved before T8.4, so the question cannot bite before then.
  person_id     uuid        references ob_people (id) on delete cascade,
  -- Who answered it, which is who to ask if the answer looks wrong.
  operator_id   uuid        references ob_people (id) on delete set null,

  -- HAND-8: the message the answer answered. One candidate per question.
  question_message_id uuid  references ob_messages (id) on delete cascade,

  decided_at    timestamptz,
  decided_by    uuid        references ob_people (id) on delete set null,
  created_at    timestamptz not null default now()
);

-- HAND-8: one candidate per question, decided here rather than by looking
-- first, because a relay that runs twice must not ask an operator to
-- review the same pair twice.
create unique index if not exists ob_knowledge_question_idx
  on ob_knowledge (agent_id, question_message_id);

-- T8.4: what an operator has to decide on, oldest first.
create index if not exists ob_knowledge_status_idx
  on ob_knowledge (agent_id, status, seq);

alter table ob_knowledge enable row level security;
