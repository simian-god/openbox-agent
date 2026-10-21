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

## K6. C13 asks for a timed out send to be flagged, and flags do not exist

**Status:** open. Closed at M9, or by a Spec change.

**What happens.** C13's last clause says a send whose outcome is unknown is
flagged. SEND-2 records it as a `send_unknown` event, which is not a flag. The
`flags` table and LEARN-1's list of flag kinds arrive in M9, and that list has no
kind for an unknown send.

**What it costs.** The M2 check cannot claim C13 in full. It was noted on T2.5
rather than quietly passed.

**What would resolve it.** Either LEARN-1 gains a kind for it and M9 raises the
flag, or C13 is satisfied by the event and the Spec says so.
