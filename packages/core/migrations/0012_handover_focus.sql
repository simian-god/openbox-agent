-- HAND-4: which conversation an operator is talking into.
--
-- An operator on WhatsApp has one thread with the agent and may hold more
-- than one handover in it. HAND-4 says a plain message from them is
-- relayed word for word to the person, so the core has to know which
-- person that is, and getting it wrong sends one customer's words to
-- another.
--
-- It lives on the handover rather than on the operator for one reason: a
-- focus that is a column on `ob_people` can point at a handover that has
-- been closed, or at one somebody else has taken, and then two rows
-- disagree about who is replying to whom. Here it cannot: the row that
-- carries the focus is the row that carries `operator_id` and `status`.
--
-- Null means never focused, so an operator who holds exactly one takes it
-- and starts typing without a second step (`take_over` stamps this).
alter table ob_handovers
  add column if not exists focused_at timestamptz;

-- HAND-4: the operator's focus is the one of theirs with the latest
-- stamp, which is read on every message they send.
create index if not exists ob_handovers_focus_idx
  on ob_handovers (agent_id, operator_id, focused_at)
  where status = 'active';
