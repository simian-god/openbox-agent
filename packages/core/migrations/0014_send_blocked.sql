-- PRO-3 and LEARN-1: one more flag kind, for a message the channel's own
-- rules would not let out.
--
-- PRO-3 says a free text proactive message outside the channel's window
-- becomes failed and flagged, and LEARN-1's table had no kind for it: the
-- nine that were there are all about what happened inside a turn. This is
-- not about a turn. It is a reminder that never reached somebody, which
-- nobody would otherwise know about, and flags are what the weekly digest
-- and `review` read.
--
-- The constraint is replaced rather than added to, because a check
-- constraint is one expression. Dropping it by name first keeps this
-- repeatable: every migration here can be run twice.
alter table ob_flags drop constraint if exists ob_flags_kind_check;

alter table ob_flags add constraint ob_flags_kind_check
  check (kind in (
    'handover',
    'gate_block',
    'low_confidence',
    'tool_error',
    'unknown_tool',
    'frustration',
    'step_cap',
    'confirmation_rejected',
    'send_blocked',
    'operator'
  ));
