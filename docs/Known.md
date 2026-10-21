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

**Status:** open, and not scheduled.

**What happens.** LOOP-10 gives a tool a 15 second timeout. Nothing gives a brain
one. A brain that never answers leaves the turn running, and `stop()` waits for
the turns in flight, so a shutdown waits with it.

**What it costs.** In development, a hung provider call means `openbox chat` or a
worker will not exit. In production it would mean a deploy that will not drain.

**What we did.** Nothing yet. It was found while writing T2.5's tests, where a
brain held on a gate did exactly this and a cleanup hook timed out.

**What would resolve it.** A timeout around `Brain.complete`, and a deadline on
`stop()`. Neither is in any current row, so it needs scheduling before anything
depends on a clean shutdown.

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

## K6. A tool's arguments are not in the event trace

**Status:** open. Closed at T3.5.

**What happens.** EVT-2's `tool_ran` records that a tool ran, its risk, whether
it succeeded and how long it took. It does not record what the tool was given.
DATA-2's `tool_runs` table holds the arguments and the result, and it is parked
at T3.5.

**What it costs.** An evals-agent assertion of the form `must_call X with {...}`
cannot be checked from the core's own events. An adapter can record the call
itself, which is what the M1 check's adapter does, but that is the adapter
watching rather than the core reporting.

**What would resolve it.** T3.5, which builds `tool_runs` alongside the gate.

---

## K7. C13 asks for a timed out send to be flagged, and flags do not exist

**Status:** open. Closed at M9, or by a Spec change.

**What happens.** C13's last clause says a send whose outcome is unknown is
flagged. SEND-2 records it as a `send_unknown` event, which is not a flag. The
`flags` table and LEARN-1's list of flag kinds arrive in M9, and that list has no
kind for an unknown send.

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

**What it costs.** Two things. Spend tracking (LIMIT-3 and the C16 spend cap,
M7) can see what a brain cost but may not be able to see what a decision cost
on this route, which would make an agent's reported spend lower than its bill.
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

**Status:** open by design, and documented.

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
through to both adapters' `fetch`. Worth doing if a real agent shows the cost,
and worth doing at the same time as K3, which is the same gap on the brain.

---

## K11. Both repositories share one local database, so their suites collide

**Status:** open, avoided by not running them at once.

**What happens.** openbox's integration tests and evals-agent's Postgres world
both use the database that `bun run db:up` starts, and both empty it between
files or cases. Run them at the same time and whichever is slower sees its rows
disappear underneath it.

**What it costs.** It has produced a batch of failures that look like real bugs
twice, once at T3.1 and once at T3.4. Both times a clean rerun was green, which
is the tell.

**What we did.** Nothing in code. A failure batch that includes several
unrelated integration files, and passes on a rerun, is this.

**What would resolve it.** evals-agent already has `EVALS_WORLD=sqlite`, which
needs no database at all, and a disposable Postgres on its own port. Pointing
evals-agent at a second database by default would close it properly, and that
belongs in evals-agent rather than here.
