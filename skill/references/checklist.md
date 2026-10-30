# Build checklist

Run every item over what you wrote, then show the builder the result, item
by item, pass or fail (SKILL-3 step 5, SKILL-9). A fail is reported, not
quietly fixed: the builder decides.

Each item says how to check it and what makes it fail. If you cannot tell,
that is a fail with the reason given.

## 1. No contradictions between sections

**How to check.** Read each of the prompt's ten sections against the other
nine, and against every tool's `callWhen` and `dontCallWhen`. Look hardest
at rules and boundaries against how to use tools, and at style against when
a turn is done.

**Fails when.** Two lines could not both be followed. "Never discuss price"
with a price tool. "Always confirm before booking" beside "book it straight
away for regulars". A style rule asking for one line while an example runs
to five.

## 2. No placeholder text

**How to check.** Search the whole project for `{{`, TODO, TBD, FIXME,
lorem ipsum, and for a bracketed hint like "your company here". The prompt
template's holes are all written as `{{like_this}}`, so one search finds any
that were left.

**Fails when.** Any of them is still there, in the prompt, a tool
description, config or a channel file.

## 3. Stop conditions stated

**How to check.** Find the sentence that says when a turn is done, and the
sentence that says what to do when something is missing. Both belong in
section 9 of the prompt.

**Fails when.** Neither is there, or the only answer is "keep going until
the user is happy", which no turn can ever satisfy.

## 4. Every irreversible tool has a confirm rule and summary

**How to check.** List every tool with `risk: "irreversible"`. Each needs a
`confirmSummary` that reads back the exact action in the person's own terms,
and the prompt's section 5 needs a line saying the agent asks and does not
claim the action is done.

**Fails when.** A `confirmSummary` is missing, or it names the tool instead
of the action, or it leaves out the detail that would make somebody say no:
the date, the time, the amount, the person.

## 5. No two tools whose `callWhen` lines overlap without a `dontCallWhen` that separates them

**How to check.** Put every tool's `callWhen` lines side by side. For each
pair that could both be true of one message, find the `dontCallWhen` on one
of them that rules it out.

**Fails when.** Two tools would both be right for the same message and
nothing separates them. Either add the separating condition or make it one
tool.

## 6. Dates handled by tools, not the prompt

**How to check.** Search the prompt for day names, "tomorrow", "next week",
time arithmetic and opening hours. Check that every tool taking a date takes
a resolved one, or resolves it with `ctx.time`.

**Fails when.** The prompt works out a date, or a tool takes free text like
"friday evening" and leaves the brain to turn that into a date.

## 7. Handover rules match `HAND-1`

**How to check.** Read the prompt's section 7 against HAND-1's triggers:
asking for a human, the `escalate` tool, repeated blocks, repeated low
confidence, repeated tool failures, and an operator taking over. The core
fires all of them except `escalate`.

**Fails when.** The prompt invents a trigger the core does not have, or
promises a person will reply within a time the agent cannot keep, or tells
the agent to keep trying when the core has already handed over.

## 8. Every tool's examples agree with its conditions

**How to check.** For each tool, read its five `should` examples against
`callWhen`, and its five `shouldNot` examples against `dontCallWhen`. Every
`should` has to be a message the conditions would allow.

**Fails when.** A `should` example would be blocked by the tool's own
conditions, or a `shouldNot` example reads like a perfectly good reason to
call it. One of the two is wrong, so say which.

## 9. The prompt doesn't restate per tool rules that belong in conditions

**How to check.** For every "only call X when" or "do not call X if" in the
prompt, check whether the same sentence is already a `callWhen` or
`dontCallWhen` on that tool.

**Fails when.** A rule about one tool is in both places. The condition is
what the gate reads, so the prompt copy is the one to delete, and a prompt
copy that has drifted is worse than useless.

## 10. Every agent table has RLS on, and any policy matches a reader the builder named

**How to check.** Read every migration the agent ships. Each `create table`
needs `alter table ... enable row level security`. For every policy, find
the reader the builder actually named in the grilling.

**Fails when.** A table has no RLS line, so `openbox migrate` will refuse to
finish. Or a policy exists that nobody asked for, which is a door the
builder does not know is open.
