# Known

Problems we are living with, and why. One place, so a workaround is not
rediscovered as a mystery.

What goes where:

- **`Known.md`** (this file): a problem that is still true. What it is, what it
  costs, what we did about it, and what would actually resolve it.
- **`Plan.md` decisions log**: a decision that was made and is settled. No longer
  a problem.
- **`Plan.md` risks**: something that might go wrong later.
- **`Spec.md` section 23**: something to check against real docs before building
  on it.
- **`Progress.md`**: the status of a task. A blocked row says what blocks it.

A row leaves this file when it is resolved, not when it is worked around. Say
which it was.

---

## K1. Bun segfaults under Postgres connection churn

**Status:** open, avoided. Not fixed.

**What happens.** Bun 1.4.0 crashes the process with a segmentation fault once
enough Postgres connections have been opened and dropped. It says so itself:
"this indicates a bug in Bun, not your code." Four connections alive in one
process was enough to reproduce it, on Windows x64. The threshold was not
characterised further, so treat four as an observation and not a limit.

**What it costs.** It has cost real time three times, and each hit looked like a
different bug until it was understood. Once here, in T1.3, and twice in
evals-agent.

**What we did.** `migrate` accepts an already open connection instead of making
its own, and the integration tests pass theirs in. Nothing in the core opens a
Postgres connection: the core reaches the database through the injected
supabase-js client, over HTTP, so only migrations and the test support touch
Bun's Postgres client at all.

**What brings it back.** A new `new SQL(...)` in the test support or in a script.
Anything that opens a connection per file or per case.

**What would resolve it.** A Bun release that fixes it. 1.4.0 is pinned here and
in evals-agent, and nobody has checked whether a later patch helps. Moving it
affects both repositories.

**Related:** evals-agent `docs/Known.md` K1, the same bug.

---

## K2. `expect(...).rejects` hangs on a Bun SQL query

**Status:** open, avoided.

**What happens.** Bun's SQL query objects are lazy and only run when awaited.
`expect(query).rejects.toThrow()` never settles, so the test hangs rather than
failing.

**What we did.** `packages/core/test/support/throws.ts` has a `failure()` helper
that awaits the query inside a try and returns what was thrown. Every test that
expects a database error uses it.

**What would resolve it.** A Bun release that settles those promises, or a
different assertion style in Bun's test runner.

---

## K3. A brain has no timeout, so `stop()` can wait for ever

**Status:** open. Scheduled at T7.6.

**What happens.** LOOP-10 gives a tool a 15 second timeout. Nothing gives a brain
one. A brain that never answers leaves the turn running, and `stop()` waits for
the turns in flight, so a shutdown waits with it.

**What it costs.** In development, a hung provider call means `openbox chat` or a
worker will not exit. In production it would mean a deploy that will not drain.

**What we did.** Nothing yet. It was found while writing T2.5's tests, where a
brain held on a gate did exactly this and a cleanup hook timed out.

**What would resolve it.** A timeout around `Brain.complete`, and a deadline on
`stop()`. Both are T7.6, along with the tool timeout and K10, because the three
timeouts are one piece of code used in three places.

---

## K4. `settled()` waits only for work that is ready

**Status:** open by design, and documented.

**What happens.** `agent.settled()` resolves when there is nothing left that
could run right now. A message still inside its burst window (LOOP-3) is waiting
rather than ready, so `settled()` returns while it sits there.

**What it costs.** A caller that wants that message answered has to let the
window pass first. It caught out the C13 burst test, which looked like a worker
bug and was not.

**What we did.** Said so on the method, and the burst test waits out the window.

**What would resolve it.** Waiting for anything pending at all, which never
returns under a frozen clock, so this is a trade rather than a bug.

---

## K5. The workspace resolves `openbox-agent` to source, not to the built package

**Status:** open. Closed at T11.3.

**What happens.** `tsconfig.json` has a `paths` entry mapping `openbox-agent` to
`packages/core/src/index.ts`, so the demo agent can import it by name with no
build step. A published consumer resolves it to `dist` instead, which no build
produces yet.

**What it costs.** Nothing we test exercises the shape a published package has:
its exports map, its types, what `files` includes.

**What would resolve it.** T11.3, which tests a fresh clone and the quickstart,
and T11.5, which publishes.

---

## K7. C13 asks for a timed out send to be flagged, and flags do not exist

**Status:** open. Closed at M9, or by a Spec change.

**What happens.** C13's last clause says a send whose outcome is unknown is
flagged. SEND-2 records it as a `send_unknown` event, which is not a flag. T3.5
built the `flags` table, so the table is no longer what is missing: LEARN-1's
list of kinds has no kind for an unknown send, and the outbox raises no flag.

**What it costs.** The M2 check cannot claim C13 in full. It was noted on T2.5
rather than quietly passed.

**What would resolve it.** Either LEARN-1 gains a kind for it and M9 raises the
flag, or C13 is satisfied by the event and the Spec says so.

---

## K8. Jev's own API cannot be live tested, and the route that can is alpha

**Status:** open, accepted.

**What happens.** DM-1 asks for Jev on two routes, and only one of them can be
reached. TypeSafe's own API is in early access behind a waitlist, with no self
serve signup, so `TYPESAFE_API_KEY` cannot be obtained here. OpenRouter serves
the same model to anyone with an OpenRouter key, but it serves it from
`POST /api/alpha/decisions`, which is alpha and says so.

**What it costs.** The TypeSafe route is built from its published API reference
and proven only against recorded responses. If that reference is wrong, nothing
here would catch it. The OpenRouter route has a live test, but an alpha endpoint
may change shape without a version bump.

**What we did.** Both routes share one request and response path, so the live
test on the OpenRouter route exercises almost all of the TypeSafe route too: the
mapping, the validation and the error handling are the same code. Only the URL,
the key and the model id differ. Both default model ids are pinned rather than
floating on `jev-latest`, so a new version cannot arrive under a running agent.
Every response is validated before it becomes an answer, so a contract that
moves shows up as a `DecisionError` rather than a wrong decision.

**What would resolve it.** A TypeSafe key, which needs their waitlist to open, or
OpenRouter promoting the decisions endpoint out of alpha. Worth re-checking both
at T3.3, which looks at the OpenAI Decisions API anyway.

---

## K9. The OpenAI Decisions API documents no usage object and no limits

**Status:** open, worked around.

**What happens.** Its guide and reference describe the request, every
question type and every answer type, but say nothing about a `usage` object,
and give no numbers for how many questions, choices or levels one request may
carry. Billing is per input token, so a usage object probably exists, but
nothing published says what it is called.

**What it costs.** Two things. Spend tracking (LIMIT-3 and the C16 spend cap)
is built as of T7.3 and prices a call from the config's pricing table whenever
the provider reports no cost, so a route that sends `usage.input_tokens` is
covered. What is not covered is a route that reports no usage at all: its
decisions then count as zero and the agent's reported spend is lower than its
bill. Which of those this route is, is exactly the open question.
And the limits this adapter cannot check are checked by the API instead, so a
question that is too big is found out by a 400 rather than refused here. Jev
publishes both of its limits and they are refused before the request.

**What we did.** `usage.input_tokens` is read if it is sent and reported as
zero if it is not, so nothing crashes and nothing invents a number. The score
mapping refuses fewer than two levels, since a score between one level is
meaningless whatever the API allows. The live test prints what the real API
reports for usage, so running it once answers the question.

**What would resolve it.** Running the live test with a real key, which
settles the usage object in one request. The limits need the endpoint to leave
beta, or an answer from OpenAI. Worth re-checking when the beta ends, which is
also when Spec section 23's first line can be struck.

---

## K10. A timed out decision request is abandoned, not cancelled

**Status:** open, documented. Scheduled at T7.6.

**What happens.** ROUTE-5 gives routing `decisionTimeoutMs` to answer, 3 seconds
by default. When it runs out, the step carries on with every tool exposed, but
the HTTP request is still in flight. Nothing cancels it, because the Spec's
`DecisionModel.ask` takes no abort signal.

**What it costs.** The abandoned request is still billed, and its connection is
held until the provider answers or the socket drops. At one request per step and
a 3 second timeout, a few per turn at worst. It also means a provider that is
slow rather than down is paid for and ignored.

**What we did.** The timer is always cleared, so a fast answer never holds the
process open, and the result is ignored rather than applied late. The alternative
is adding a signal to `DecisionModel`, which changes an interface in the Spec for
a cost that is small today.

**What would resolve it.** An abort signal on `DecisionModel.ask`, passed
through to both adapters' `fetch`. Scheduled at T7.6, with K3, which is the same
gap on the brain.

---

## K11. Both repositories share one local database, so their suites collide

**Status:** open, avoided by not running them at once, and by rerunning after
an evals-agent run.

**What happens.** openbox's integration tests and evals-agent's Postgres world
both use the database that `bun run db:up` starts, and both empty it between
files or cases. Run them at the same time and whichever is slower sees its rows
disappear underneath it.

It is not only about running them at once. evals-agent's Postgres world is
disposable: it rebuilds the schema for a case, which leaves the shared database
without the migration rows openbox's `migrate` expects. So the openbox run
*after* an evals-agent run fails too, in `migrate` rather than in an assertion.
That run reapplies the migrations as it goes, so the run after that is green.

**What it costs.** It has produced a batch of failures that look like real bugs
three times: T3.1, T3.4, and T3.5, where the trigger was a sequential
evals-agent subject check rather than a concurrent one. Every time, a clean
rerun was green, which is the tell.

**What we did.** Nothing in code. A failure batch that includes several
unrelated integration files, or a `migrate` error, and passes on a rerun, is
this. Run `bun run check` twice after touching evals-agent and believe the
second one.

**What would resolve it.** evals-agent already has `EVALS_WORLD=sqlite`, which
needs no database at all, and a disposable Postgres on its own port. Pointing
evals-agent at a second database by default would close it properly, and that
belongs in evals-agent rather than here.

---

## K12. The gate cannot say which condition it doubted

**Status:** open by design. Resolved by a Spec change, or by asking per
condition.

**What happens.** GATE-2 says a Confirm tells the brain the call needs the
person's confirmation, "quoting the condition in doubt". GATE-1 asks one yes/no
question, and it comes back as one probability about all of the conditions at
once. Nothing in that number says which condition the model doubted, so the
brain is given every condition the call was judged against instead.

**What it costs.** A list makes a less pointed message than one quoted line
would. The brain still has what it needs to ask the person the right question,
but it has to work out which part is missing, which is the bit a quoted
condition would have done for it.

**What we did.** Quoted all of them, and said so where it happens. Quoting one
would mean guessing, and a guess presented as the reason a call was stopped is
worse than a list.

**What would resolve it.** Either GATE-1 asks one yes/no per condition, all in
one request, which DM-2 allows: that costs more tokens on every gated call and
gives a per condition answer. Or GATE-2 is reworded to ask for the conditions
rather than the condition. The first is a real option and is a builder's
decision, since it trades money for a better message.

---

## K13. C8 cannot be measured on the demo agent

**Status:** open, worked around. Closed at T11.1.

**What happens.** C8 compares the same turns with routing and without it.
Routing only runs above `routingMinTools` agent tools, 5 by default (ROUTE-1),
and `examples/demo-agent` has one tool. So on the demo agent there are no two
arms to compare, and `openbox tune` has no threshold to measure either. Both
commands say so and stop rather than reporting a number about nothing.

**What it costs.** M3's "Done when" asks for C8 to be measurable on the demo
agent, and it is not. The measurement itself is real, and runs on a fixture. The
M3 check row is `blocked` because of this one item, which was the builder's call:
rewording the bar would have closed the row and lost the reminder.

**What we did.** Built `packages/core/test/fixtures/routing-agent`: eight tools
across all three risk levels, each with the conditions and examples TOOL-1 asks
for, plus its own `examples/routing.jsonl`. `bun run c8 --dir
packages/core/test/fixtures/routing-agent` measures C8 there. It is test data,
not a second example to learn from, and its README says so.

**What would resolve it.** T11.1 rebuilds the demo agent with the skill, and a
real restaurant agent has far more than five tools. C8 moves onto it then and
this fixture can go. `bun run m3-check` is in the repo so that row can be
re-run in one command rather than rebuilt from the Plan.

---

## K15. The privacy design is one reading of the DPDP rules, not a lawyer's

**Status:** open, and waiting on the builder. Needed before M9 is built, not
after.

**What happens.** Intent goal 21 says the design is "to be confirmed with a
lawyer", and it has not been. So PRIV-1 to PRIV-4 in the Spec are a careful
reading of India's DPDP Rules, written by someone who is not a lawyer. M9 turns
that reading into code.

**What it costs.** Everything in M9 except one thing is only a rewrite if the
reading is wrong. The exception is erasure, which deletes rows: PRIV-3 is the
one operation in this system that cannot be walked back. Finding out afterwards
that something had to be kept means it is already gone, from the test agent and
from anything running.

The obligations that matter apply from 13 May 2027, so there is time. This is
about order, not urgency: the answer wants to arrive before the code.

**The questions to take into that conversation.** Each one is a place the Spec
is currently a guess, and each changes what gets built.

1. **What may be kept after someone is erased?** PRIV-3 keeps a hashed
   reference to the person, when it happened and who did it, in `erasure_log`,
   and clears all text from their inbox rows and events while keeping the ids,
   timestamps and event names. Is that the right minimum, and does a hashed
   reference count as erased?

2. **Is the retention period entirely the builder's choice?** Config requires
   `retentionDays` and accepts any number. If the rules set an outer limit for a
   category of data, config should refuse a longer one, and that is a validation
   rule rather than a document.

3. **What must the first contact notice actually say?** PRIV-1 requires a notice
   string and records that it was shown. Is one plain sentence enough, or must
   specific items be listed? If the latter, the notice stops being free text and
   becomes a template with required fields.

4. **Does export have a required shape or deadline?** PRIV-4 returns one JSON
   document with everything stored. A required format or a time limit would make
   it a job rather than a tool call.

5. **Is consent needed for anything the core does beyond the notice?** The
   agent stores conversations, facts about people and transcripts of voice
   notes. The Spec treats the notice as sufficient for all of it.

6. **Does anything change if a person is a child, or outside India?** Neither
   is in the Spec at all, which is either correct or a gap.

7. **One retention period, or one per kind of data?** Config has a single
   `retentionDays` today, covering conversation text, audit records and stored
   facts alike. Should those differ, and is there an outer limit we must
   enforce rather than offer? This decides whether retention is a config field
   or a validation rule.

**What the skill does meanwhile.** SKILL-11 makes `new` ask the builder these
questions in its own words before it writes a config, and stop with a plain
warning when the answer involves health, financial, ID or children's data.
SKILL-12 writes the answers into the agent's own `docs/privacy.md` with a line
saying nobody has reviewed them. That captures a decision and a date. It is not
a substitute for the conversation below, and the answers to questions 2 and 7
change what the skill is allowed to accept.

**What would resolve it.** One conversation with a lawyer, with the seven
questions above, and then a decisions log row per answer and whatever Spec
changes they imply. Before M9, which is five milestones out.

---

## K18. Knowledge candidates have nobody to approve them until T8.4

**Status:** open, scheduled. Not a workaround.

**What happens.** T6.5 saves the question and answer from every exchange
in a handover as a `candidate`. LEARN-6 says a candidate is not searchable
until an operator approves it, and `approve_knowledge` and
`reject_knowledge` are T8.4, with the index. So candidates accumulate and
nobody can act on them.

**What it costs.** Nothing is wrong, and nothing is lost: the rows are the
point, and a candidate that cannot be searched is exactly what LEARN-6
asks for. What is missing is the operator's half, so the agent does not
yet get any better for having learned something.

**What would resolve it.** T8.4, which is `search_knowledge`, the two
approval tools and KNOW-2's live indexing.

**What to do meanwhile.** Read `ob_knowledge` in the database to see what
the agent would have learned. Nothing has to be cleaned up first: an
approval tool arriving later finds the candidates waiting.

---

## K19. PRIV-3's erasure list predates knowledge entries

**Status:** open, and waiting on the builder. Needed before M9 is built.

**What happens.** PRIV-3 names the tables erasure clears: messages, facts,
tasks, pending actions, handovers, flags and the person row. Knowledge is
not among them, because knowledge did not exist when that line was
written, and a candidate holds the person's own words.

**What we did.** `ob_knowledge.person_id` cascades, so erasing a person
takes their candidates with them. That is the safe half, and a test proves
it. The open half is an entry that has already been approved: deleting it
loses an answer the shop now relies on, and keeping it keeps a sentence
the person asked to be forgotten.

**What it costs.** Nothing yet. Approval is T8.4, so no approved entry can
exist before then, and erasure is M9. The question cannot bite until both
are built.

**What would resolve it.** The builder deciding, before M9: delete the
entry with the person, keep it, or have the operator rewrite it as general
knowledge on approval so no personal words survive. Then one line in
PRIV-3 saying so.

---

## K20. A trigger can only compose, so an "order ready" message cannot be a template

**Status:** open, and waiting on the builder. Needed before T7.2.

**What happens.** Section 12's signature for `trigger` takes an event, its
data and `urgent`. It has no `text` and no `template`, so every triggered
message is written by the brain. PRO-3's third rule says that outside the
channel's window, which is 24 hours on WhatsApp, only a template goes out,
and a free text message with no template becomes `failed` and flagged. So
the one example Intent 16 gives for a trigger, "order ready", cannot reach
a WhatsApp customer who last wrote two days ago. It gets written, refused
and flagged.

**What we did.** Built `trigger` exactly as the signature reads. A glue
that needs a template for an event today can call `schedule` with `at` set
to now, which is the same job row and the same code path, so nothing is
blocked meanwhile.

**What it costs.** As of T7.2, which built the window rule, it costs a
brain call per blocked event. A triggered message is composed first and
refused afterwards, because PRO-3's rules live in the outbox, just before
the send, which is where the Spec puts them. The refusal is recorded and
flagged as `send_blocked`, so it is visible rather than silent, but the
message still does not arrive.

**What would resolve it.** The builder deciding whether `trigger` also
takes `text` and `template` the way `schedule` does, or whether a map in
config says which template each event uses outside the window. Then one
line in section 12.

---

## K16. Four brains ship, not the five Intent names

**Status:** open by decision. Resolved by building T5.3, which now sits in After
release.

**What happens.** Intent goal 2 names five brains: OpenRouter, the Claude Agent
SDK, the OpenAI Agents SDK, Claude Code and Codex. The OpenAI Agents SDK is
parked at the builder's decision, on usage limits and reasoning quality. Intent
is never edited, so it still says five and four exist.

**What it costs.** Less than the sentence above suggests.

- OpenAI's models are still reachable, through OpenRouter. What is parked is one
  vendor specific code path, not access to GPT.
- The OpenAI Decisions API is a different dependency, is built, and is tested.
  C3 is unaffected.
- BRAIN-5's fallback chain still has two production brains, and OpenRouter
  itself fronts many vendors.

What is actually lost is the SDK's own features, whatever they turn out to be
worth, and C2's claim that the same conversation runs on five brains rather than
four.

**What we did.** `openai-agents` stays a valid config id with its env key
reserved, and `providersFromConfig` already says plainly that its adapter is not
built rather than failing obscurely. C2's bar was reworded to the brains that
exist, because the blocker is a vendor improving and that has no date, and a
milestone that cannot close would hold M6 to M9 behind it.

**What would resolve it.** T5.3, which is one `ask` function on T5.1's adapter
plus its section 23 check. The adapter is the part that was expensive and it is
already done, so this is cheap whenever it is wanted.

## K21. The Sarvam transcriber will ship untested, and Hinglish is the reason it ships at all

**Status:** open, accepted, and deliberately deferred.

**What happens.** T7.4 builds two transcribers. The OpenRouter one is the one
to reach for, and it will be checked against the real endpoint like every other
provider here. The Sarvam one is built from Sarvam's published API and will not
be run against it, because that needs a `SARVAM_API_KEY` and, to mean anything,
real voice notes in Indian languages and in Hinglish. Neither exists here yet.

**Why it ships anyway.** Sarvam is not on OpenRouter. That was checked against
OpenRouter's live model catalog, not assumed: it serves 28 speech to text
models and none of them is Sarvam's. Saaras is the only route to the 22 Indian
languages plus English that it covers, and the only one with a mode for
code-mixed speech. Intent 17 names exactly that case first. So the choice was
not between two adapters and one, it was between keeping a route to Hinglish
and not having one.

**What it costs.** Two things, and they are different sizes.

The small one: an adapter nobody has run. It sits behind a one method interface
(`transcribe(media) -> { text, language? }`), it is reached only by an agent
whose config names it, and it is proven against recorded responses, so a
contract that has moved shows up as a failure in that adapter and nowhere else.
Nothing else in the core can be affected by it being wrong.

The larger one: we do not know how well the OpenRouter models handle Hinglish,
and that is the question the default rests on. `elevenlabs/scribe-v2` advertises
90 or more languages and Hindi is among them, but code-switching inside a
sentence is where a model trained on one language at a time tends to mistranscribe
or transliterate rather than fail outright. A wrong transcript is worse than a
failed one, because MEDIA-1 stores it as the message text and the brain answers
it as though the person said it. Nothing in the core can detect that.

**What we did.** Built both, defaulted to OpenRouter, and left Sarvam as the
switch to throw if real audio comes out badly. Switching is a config line and no
code change, which is the whole point of DEP-2 being an interface.

**What would resolve it.** Real voice notes. Twenty or so in Hinglish and in two
or three Indian languages, run through both transcribers, with the transcripts
read side by side. That is a measurement, not a build, and it needs a
`SARVAM_API_KEY` and audio from the builder. Until then the default is a
reasonable guess and is written down here as one.
