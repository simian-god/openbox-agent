# Progress

The coding agent keeps this file up to date (see AGENTS.md). You don't need to track task numbers yourself.

Statuses: `todo`, `doing`, `done`, `blocked`. A milestone check row is done only when every item in that milestone's "Done when" passes.

**Next task:** T4.4. The M3 check row stays `blocked` until T11.1.

## M0. Foundations

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T0.1 | Workspace, MIT license, README stub, `.env.example` | done | 2026-10-15 | Bun workspace (core, skill, example), MIT, README stub, .env.example, repo tests for REL-1 and REL-2 in packages/core/test. |
| T0.2 | Strict tsconfig, Biome as a formatter only (no lint rules), `bun test`, CI on Linux and… | done | 2026-10-15 | Strict tsconfig, Biome formatter only, bun run check, CI matrix on Linux and Windows plus gitleaks, DEP-1 source scan test. CI itself unverified until the first push. |
| T0.3 | `scripts/trace.ts`: reads every Spec ID, finds tests that name it, prints the uncovered ones | done | 2026-10-15 | 126 Spec IDs parsed, 3 covered (DEP-1, REL-1, REL-2), 123 uncovered. Warns in CI, `--strict` fails from M11. |
| T0.4 | Supabase local stack, `bun run db:up`, an integration test helper that resets the database per… | done | 2026-10-15 | Supabase CLI pinned as a dev dependency, stack trimmed to Postgres, PostgREST and Studio. `bun run db:up`. Per file reset by truncate; integration tests skip with no database. CI gains an integration job. |
| M0 check | CI is green, and the trace report runs and lists the Spec IDs that have no test. | done | 2026-10-16 | Both pass. All four CI jobs green on 81e7b0c; trace reports 122 of 126 uncovered. Bar reworded, see the decisions log. |

## M1. Walking skeleton

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T1.1 | `defineConfig` and validation, including the required spend cap, retention and notice | done | 2026-10-16 | zod schema for section 19, strict objects, defaults filled in, every problem reported in one pass. CFG-2 enforced by rejecting credential shaped fields. CFG-1 tool rule waits for createAgent. |
| T1.2 | `defineTool` and registration rules, zod to JSON schema, the description the brain sees | done | 2026-10-16 | defineTool with all TOOL-2 rules reported at once, zod to JSON schema verified against zod 4.6, TOOL-3 description, registry with name clash and role filtering. ToolContext is a placeholder until T1.6. |
| T1.3 | First core migrations (`ob_people`, `ob_inbox`, `ob_turns`, `ob_messages`, `ob_events`… | done | 2026-10-16 | Six core tables plus ob_migrations, all with RLS on and no policies. `openbox migrate` applies core then agent migrations, refuses to finish if any table has RLS off, and refuses an edited migration. Bun 1.4.0 crashes on many connections and hangs on expect().rejects for sql queries, both worked around. |
| T1.4 | Store layer: every query scoped by `agent_id` in one place | done | 2026-10-16 | One scoped helper is the only place that calls db.from, enforced by a test. agent_id is stamped on insert and never patchable. Proven against a fake client and against real PostgREST, including that the anon key sees nothing. |
| T1.5 | `Brain` interface, scripted brain, OpenRouter brain with native tools, `providersFromConfig` | done | 2026-10-16 | Brain interface plus BrainMessage, now defined in Spec section 4 (see decisions log). OpenRouter checked against its real docs and built on recorded responses; one opt-in live test calls the real API. Scripted brain for offline tests. providersFromConfig reads keys from the environment and lets passed in instances win. |
| T1.6 | Turn v0: receive, create the person, one synchronous turn, step loop with read tools, the… | done | 2026-10-16 | createAgent and receive, person created as end_user, duplicates dropped, LOOP-8 steps 3 to 10 for read tools, unknown tool and bad arguments returned to the brain, reply through the sender. Found that conversation order rested on a timestamp, so migration 0002 adds a seq column; Spec DATA-3 updated, see decisions log. |
| T1.7 | Events table and capture, version hashing, both wired from the start | done | 2026-10-20 | EVT-2's names are held to the Spec's own table by a test. Turns, duplicates, tool runs, unknown tools and brain fallbacks all record themselves, to ob_events and to deps.events.capture, and a failure to record never costs the person an answer. LEARN-2 version hash wired in, so every turn carries the version it ran under. ob_events gains a seq and a tool's roles join the hash, both in the decisions log. |
| T1.8 | Terminal channel and `openbox chat` | done | 2026-10-20 | Terminal channel with a Sender, printed buttons tapped back by number, and chat commands on a colon so an operator's / commands still reach the agent. `openbox chat` builds the agent from the standard layout in the folder it is run in. A hand written one tool demo agent to chat with, replaced at T11.1. Found and fixed a deadlock: the executable was in the import circle the agent project pulls in, so chat hung with no output. A subprocess test now covers the real command. |
| M1 check | `openbox chat` against a one tool agent answers through OpenRouter, every turn writes events and a version, and TOOL-2, ROLE-1 and LOOP-8 step 5 have passing tests. | done | 2026-10-20 | All three pass. Live turns through OpenRouter at about 0.025 cents each, every turn carrying a version and its events, TOOL-2 20 tests, ROLE-1 4, LOOP-8 step 5 2. The live run caught a real fault the suite could not: the demo tool accepted a raw date, so the model did its own date arithmetic and reported Friday's hours as Sunday's. The tool now takes a closed list of days and does the arithmetic itself. |

## M2. Reliability engine

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T2.1 | Duplicate drop on insert, `receive` returning in under 100 ms, `receiveAndWait` | done | 2026-10-20 | receive now writes the person and the inbox row and returns, with the turn running behind it; receiveAndWait waits for the turn and its sends. A turn can no longer reject, since nothing awaits it: a failure becomes a failed outcome on the turn, the inbox row and the trace, and goes to onTurnError. A retried webhook that waits lands on the turn the first delivery started. inFlight and settled added to the API, see the decisions log. The worker and leases are T2.2. |
| T2.2 | Person leases, the worker, burst merge, and turns that follow on | done | 2026-10-20 | ob_person_leases plus a worker: receive only writes, the worker claims a person and runs their turns, and nothing happens until agent.start(). The claim is DATA-4's conditional update, so of several workers exactly one wins and more processes is the safe way to add throughput. Messages waiting together become one turn in arrival order, and one arriving mid turn gets the next turn under the same lease. agent.start and agent.stop. Three config fields added, see the decisions log. Found: a process killed mid turn leaves its rows merged forever, so nothing picks them up again. Needs a recovery sweep, not built. |
| T2.3 | Outbox: states, retries with backoff, idempotency keys, the timed out send rule | done | 2026-10-20 | ob_outbox with the five DATA-2 states. A reply is written down before it is sent, so it can be retried or seen to have failed. The Spec described the three send outcomes but said nothing about what to do with them, so SEND-1 to SEND-4 now do: a thrown send is unknown and not retried unless the channel is idempotent, five attempts doubling from a second, and one person's messages go out one at a time in order. receiveAndWait waits for the sends, bounded. The three workers now share one pump. CI caught a test race the local machine hid: reading a lease before the claim landed, which then left a gated brain blocked, hung stop(), and let that agent do four other tests' work. Gates are now always opened on cleanup, so one failure stays local. |
| T2.4 | Job loop: claim, run, retry, dedupe keys, and a recovery sweep for turns a dead process left behind | done | 2026-10-20 | ob_jobs plus the loop, as the third user of the shared pump: claimed by conditional update, run under a lease, taken over when that lease expires, retried with backoff, deduped by key (PRO-1). The recovery sweep hands back messages a dead process left mid turn, which was the last way a message could be lost. A reply is now keyed by the messages it answers, not by the turn, so a recovered message cannot be answered twice. JOB-1 to JOB-4 added to the Spec. Two defaults still open for the builder, see the questions. |
| T2.5 | Integration tests: the same webhook twice, three messages in a burst, two worker processes on… | done | 2026-10-20 | A suite for C13's four claims as a whole, not a piece at a time. The one that needed it: two processes on one database, eight people messaging twice, with a watcher proving nobody was ever inside two turns at once and that both processes really competed. Also found that settled() waits for work that is ready, so a message inside its burst window is not waited for; documented. C13's "flagged" half needs the flags table, which is M9. |
| T2.6 | Gate: run a minimal agent under evals-agent's harness and confirm DATA-4's conditional updates… | done | 2026-10-21 | The gate passes and is no longer blocked. evals-agent's shim builds update ... where ... returning * with every filter the core uses, so DATA-4's claims hold there. An openbox agent now runs under the harness over its own ten migrations with no module mocking and no ported database functions, which is TEST-1 and TEST-2 earning their place. Three faults found between the two repositories, all fixed: the shim's errors carry no SQLSTATE, so duplicate detection here reads the message too; the shim left bigserial alone, so sequences were NULL, fixed in evals-agent; and a json column came back as a string, so a reply went out empty, also fixed there. A flake of my own in this row's own test, which asserted on one of two senders when either may win. |
| M2 check | C13's tests pass against Postgres and under the evals-agent harness. | done | 2026-10-21 | Both halves pass. Against Postgres: the C13 suite plus 409 tests, three clean runs. Under the harness: all four claims, in both of its worlds, with the agent's own event trace as the evidence. A webhook delivered twice gives one turn and one inbox row. Three messages in the burst window give one turn over three rows. Two real agents on one database, each with its own lease owner, give one turn and one owner for one person. A send whose outcome is unknown leaves the row unknown after one attempt and says nothing to the person. One clause of the C13 criterion is still outstanding and is Known K7: it asks for a timed out send to be flagged, and flags are M9. |

## M3. Decision model, routing and gating

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T3.1 | `DecisionModel` interface, scripted decision model | done | 2026-10-21 | The interface from Spec section 4, with three question types and probabilities rather than prose. DM-2 is in the shape: `ask` takes every question for a step at once. `DecisionError` is its own type, so the gate can tell an outage from an answer (GATE-4). The scripted model is deliberately unhelpful: an unscripted question gets the most boring answer there is, and a fixture that cannot be true is refused when it is written. Row was left `todo` by a missed edit in the T3.1 commit; corrected here. |
| T3.2 | Jev adapter, through TypeSafe and through OpenRouter, with recorded contract tests | done | 2026-10-21 | Checked against the real docs first: both routes take the same body, so one adapter serves both and only the URL, the key and the model id differ. The mapping DM-1 asks for: our yesno is Jev's noul, our options and levels are both its criteria, and its confidence is passed through rather than recomputed, because the docs say it describes the whole distribution and is not the top probability. Jev's score is an expected level and comes back fractional, so the fraction is kept. Two documented limits are refused before a request is paid for, 255 options and 2 to 10 levels. Every response is validated before it becomes an answer, on the same rule the scripted model holds its fixtures to. One live test through OpenRouter. TypeSafe's own route cannot be live tested, which is Known K8. |
| T3.3 | Check the OpenAI Decisions API's real shape, then build its adapter | done | 2026-10-21 | Checked against OpenAI's own docs, which closes the first line of Spec section 23. A different wire shape from Jev in almost every way: questions and answers are arrays with the name inside, choices and levels are objects, probabilities are lists, input takes text so a state that is not a string is written out, and a predicate takes no criteria so whenTrue and whenFalse are folded into the instructions rather than dropped. It also has an answer type no other route has, refusal, which is raised as a DecisionError so it can never read as a confident no. A 429 is split in two by its body: a rate limit retries, exhausted credit does not. The docs describe no usage object and no limits, which is Known K9. The validation both adapters share now lives in decision/validate.ts. C3 earns a test here: both models answer the same step identically from their own wire shapes. |
| T3.4 | Routing: options, exposure rules, every step, fallback on failure, more than 255 options… | done | 2026-10-21 | Routing narrows the tool list only when the decision model is confident. Below the threshold, and whenever the model fails or is slow, the brain sees every tool the role allows: routing is an optimisation, and an unsure optimisation must not make the right tool unreachable. It is the one place in the core that fails open, which only works because the gate decides whether a call runs. Runs on every step, so a second step can route elsewhere, proven on a real two step turn. DM-3 splits more than 255 options into groups asked in one request, then a runoff over the group winners, with no runoff when the groups settle it. Built in tools are never routing options and are exposed whatever routing says. The decision model is now a required dependency and is built from config, which took route, model and decisionTimeoutMs into config, both in the decisions log. Known K10: a timed out request is abandoned, not cancelled. The evals-agent subject was updated and still passes in both worlds. |
| T3.5 | Risk levels, the gate, bands per tool, failing closed, the `tool_runs` and decisions tables, `gate_block`… | done | 2026-10-21 | The gate fails closed, which is what lets routing fail open. One yes/no question about the proposed call, and the band the probability lands in decides: a write runs, needs the person's confirmation, or is blocked. An irreversible call never runs on a confident yes, because CONF-1's structured confirm is M4, so passing the gate means a confirmation is required rather than a call is made. An outage is a Confirm and not a Block: the model did not say no, it said nothing, and telling the person their request was refused because a vendor was down would be a lie the brain could not catch. Write and irreversible tools are now offered to the brain, which they never were before: withholding them was only ever a stand in for this. Three tables (`ob_tool_runs`, `ob_decisions`, `ob_flags`), and GATE-3 reads the decisions table, since two Blocks in a row is a question about rows; the trigger is detected and reported, and opening the handover is T6.2. `gate_block` and `low_confidence` flags raised, the rest of LEARN-1 declared but left to T9.1. Closes Known K6: a tool run now records the arguments the brain proposed. New Known K12: one yes/no cannot say which condition it doubted, so every condition is quoted. An `outcome` column on the decisions table is in the decisions log. Seven deliberate probes, each caught. The evals-agent subject still passes all three M1 bars in both worlds, over 13 tables now. |
| T3.6 | `openbox tune` v1: accuracy and thresholds from `examples/routing.jsonl` | done | 2026-10-21 | The threshold is a price, so the builder sets what they will pay: `--tolerance`, the share of examples that may lose their tool, 1 in 100 by default. tune reports the lowest threshold inside it, lowest because every step above is a turn paying full price for a tool list it did not need. It reads every tool's own `should` and `shouldNot` examples as well as `examples/routing.jsonl`, so a new agent can be tuned before it has any traffic, and a reviewed line wins over an imagined one. It asks once per distinct question rather than once per label, which on the test project turned twelve examples into seven requests, and never once per candidate threshold: a threshold changes what the core does with an answer, not the answer, so 101 of them cost what one costs. The measure calls ROUTE-2's own `topTools` rather than its own idea of exposure. A recommendation that narrows almost nothing is reported as routing not being worth asking for, not as a tuned number. LEARN-7 wins over ROUTE-4's word "sets": it reports, and `--write` replaces exactly one number. No database and no brain key, since it needs neither. Five decisions in the log, all four the builder's. Eleven deliberate probes, each caught. Found and fixed two of my own faults: six tools sharing a `shouldNot` message collapsed into one label, and `tune` reached the usage text without reaching the switch, so a static check now holds the two together. |
| T3.7 | Measurement script for C8: one labeled set run with and without routing, reporting accuracy… | done | 2026-10-21 | `bun run c8` answers one labeled set twice, once with the tools routing chose and once with every tool, interleaved so a slow minute on the provider hits both arms. The routed arm is charged for its own decision request in time and in money, which is the whole honesty of it: routing buys a shorter tool list and pays a request for it, and bar 2 is whether that comes out ahead. One step, not a whole turn, because routing changes one thing and the rest of a turn costs the same either way. Bar 2 cannot pass unless the brain reported what it charged, which catches the scripted fake and also a real provider that leaves cost out of its usage. It prints what it would spend and waits for `--go`, since 98 brain calls on the fixture is the most expensive thing in the repo. Measured on a new fixture agent, eight tools across all three risk levels, because the demo agent has one tool and routing never runs there: that gap is Known K13 and closes at T11.1. Ten deliberate probes, each caught, plus one that could not be broken and was replaced by a rule that can. Two faults of my own: a fake brain that called tools it was never offered, and a flake comparing 0 ms with 0 ms. |
| M3 check | C3, C7 and C8 can be measured on the demo agent, and a decision model outage test proves GATE-4. | blocked | 2026-10-22 | Three of four pass, and one fails on purpose. `bun run m3-check`. C3 PASS: the demo agent's own config with nothing changed but `decisionModel` builds and starts on jev and on openai-decisions, and the two version hashes differ, which is right because a swap is a change to the agent. C7 PASS: the demo agent's own tool, with its conditions taken away, is refused with an error naming the field, for a missing callWhen, a missing dontCallWhen and both. GATE-4 PASS: with the decision model down, a write and an irreversible call both come back as confirm and neither runs, while a read tool is untouched. **C8 FAIL:** the demo agent has one tool and routingMinTools is 5, so routing never runs there and there are no two arms to compare. The measurement itself works, on `packages/core/test/fixtures/routing-agent`. Left as a fail rather than reworded, at the builder's call, so it is not forgotten. Known K13. Re-run this row at T11.1, when the skill rebuilds the demo agent. |

## M4. Confirmation, tasks and time

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T4.1 | Pending actions, signed Confirm and Cancel payloads, codes, expiry jobs, cancellation rules… | done | 2026-10-22 | An irreversible call now stops being a decision and becomes a question. Passing the gate creates a pending action, the core sends the confirm message itself with signed Confirm and Cancel buttons, or the four digit code on a channel without them, and the brain is told it has asked and must not say the action is done. CONF-4's four rules are each a test written as the attack: a tampered signature, a correctly signed payload for someone else's action, an arrival after expiry, and arguments changed since the person saw them. C9's "why do you keep asking, i already told you" is one of them and runs nothing. CONF-5's claim is proven by resolving the same action twice at once, which needed `agent.confirmations` on the public Agent, because the person lease stops two taps ever racing through `receive`. A resolved confirmation becomes a notice in the conversation and the brain tells the person, which was the builder's call; the notice is stored, so a later turn cannot claim nothing happened. Expiry is a job per action, conditional on still being pending. `OPENBOX_SECRET` is required only for an agent that has an irreversible tool, and refused at startup rather than when someone is first asked to confirm. Thirteen deliberate probes. Three of them failed to bite the first time, all three on rules that were only ever covered by another rule standing in front of them, and each got a test that makes it load bearing. Also deflaked an existing jobs test that waited on a proxy instead of the thing it asserts. CONF-6's second half, the brain changing a task's fields, waits for T4.2. |
| T4.2 | Task table and built in task tools, with `missing` computed by code and idle expiry | done | 2026-10-22 | A conversation that takes five turns now remembers where it got to. `ob_tasks`, the four task tools from section 10, and the one rule that matters: `missing` is computed from the task type on every change and the brain can never write it, because a brain that could would eventually say nothing is missing in order to finish. An empty string counts as missing, since a date set to "" has not been found out. A field the type does not declare is refused rather than stored, because `missing` could never account for it. C14 is proven end to end over six real turns: party size, date, a detour about parking that touches no field, the time, the booking, and the confirmation, with every field correct at the end. BUILTIN-1 is wired properly at last: built in tools are exposed on every step whatever routing says, and do not count toward routingMinTools. That needed `defineBuiltinTool`, a second door that insists the name is one of section 10's, so nothing can smuggle an ordinary tool past routing. The version hash deliberately still covers only the builder's tools. LOOP-7's runtime block now lists each open task, what is known and what is missing, and any pending action with a line saying it has not happened yet. Idle expiry is a job per expiry time, so a change pushes the window out and the older job finds the task no longer idle. Closing or changing a task cancels the pending action on it, which closes CONF-6's second half and BUILTIN-3's. Seventeen probes, each caught; one of them found that nothing covered a closed task cancelling its action, and that is now a test. |
| T4.3 | Time helpers with frozen clock tests across midnight, month end and timezone; opening hours… | done | 2026-10-22 | Date arithmetic now happens in code, never in a model, which is the constraint the M1 live run broke the hard way. `ctx.time` gives a tool `resolve`, `isOpen`, `nextOpen` and `format`, all in the agent's timezone. chrono-node and Luxon, both already in Plan section 4, and running them first paid for itself twice: chrono resolves against the process's local timezone, so it is used only as a phrase to components parser and `result.date()` is never called; and chrono will match part of a phrase and drop the rest, so "the 31st at 9" came back as today at 9, which is now ambiguous rather than confidently wrong. A day with no time of day is ambiguous too, since booking a table at the parser's default noon is how you lose a table. A bare weekday is acted on and read back, because asking "which Friday?" every time is worse; "next friday" offers both. C15 proven on frozen clocks across midnight, month end, year end and two timezones, and on real turns where the tool refuses an out of hours booking three times while the brain insists. TIME-1 is enforced by a source scan: only `systemClock` reads the real clock, which also turned the terminal's session id from a timestamp into something random. `fakeToolContext` joins the testing kit, because nine tests hand built a context and all nine broke when `ctx.time` arrived. Fifteen probes, each caught. Found and wrote down Known K14: an intermittent failure in SEND-4's ordering test under the full suite, not reproducible alone, not root caused, and now instrumented so the next occurrence says which of two causes it is. |
| T4.4 | `remember` and `forget_fact`, and the full runtime block | todo | | |
| M4 check | C9, C14 and C15 pass with the scripted brain and decision model. | todo | | |

## M5. All five brains

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T5.1 | Shared structured output adapter for brains without native tool calling | todo | | |
| T5.2 | Claude Agent SDK brain: check one turn structured output with no built in tools | todo | | |
| T5.3 | OpenAI Agents SDK brain | todo | | |
| T5.4 | Claude Code CLI and Codex CLI brains: check the flag combinations, including spawning on… | todo | | |
| T5.5 | Fallback chain, dropping extra tool calls, refusing CLI brains in production | todo | | |
| T5.6 | Conformance suite: one scripted conversation run on all five brains | todo | | |
| M5 check | C2 passes. | todo | | |

## M6. Handover and operators

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T6.1 | Operator role, `openbox operator add`, role filtering, blocking, operator tools | todo | | |
| T6.2 | Handover states and every trigger: `escalate`, `wants_human`, repeat rules | todo | | |
| T6.3 | Operator focus, word for word relay, `/` commands | todo | | |
| T6.4 | Waiting and idle timeouts as jobs | todo | | |
| T6.5 | Knowledge candidates from operator answers | todo | | |
| M6 check | C5, C11 and C12 pass. | todo | | |

## M7. Proactive messages, limits and media

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T7.1 | `schedule` and `trigger`, fixed and composed messages | todo | | |
| T7.2 | Send rules: opt out, quiet hours, channel window and templates, STOP and START | todo | | |
| T7.3 | Rate limit, step cap, spend tracking with the pricing table, the spend cap triggering handover | todo | | |
| T7.4 | Sarvam and OpenAI transcribers, language detection | todo | | |
| T7.5 | Images and `sendFile` | todo | | |
| T7.6 | Timeouts and cancellation: the brain, the tools, and a deadline on `stop()` | todo | | |
| M7 check | C10, C16 and C17 pass. | todo | | |

## M8. Knowledge

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T8.1 | Loading knowledge files and chunking them | todo | | |
| T8.2 | `local` retriever on MiniSearch, an optional OpenAI embedder, and blended scores | todo | | |
| T8.3 | pgvector retriever and its optional migration | todo | | |
| T8.4 | `search_knowledge`, and approved entries added to the index live | todo | | |
| M8 check | C18 passes on the `local` retriever. pgvector passes on Postgres; under evals-agent it waits for sqlite-vec support. | todo | | |

## M9. Learning, personal data and failure paths

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T9.1 | Every flag in LEARN-1, including the frustration question | todo | | |
| T9.2 | Weekly digest job | todo | | |
| T9.3 | Notice on first contact, retention job, erase, export, the `erase_person` tool | todo | | |
| T9.4 | Failure sweep: inject a failure into each dependency in turn, then all at once | todo | | |
| M9 check | C19 and C21 pass, plus the core side of C20 (flags raised, digest correct). | todo | | |

## M10. The `/openboxagent` skill

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T10.1 | `best-practices.md`, `checklist.md`, `prompt-template.md`, condensed from Anthropic's and… | todo | | |
| T10.2 | `SKILL.md`: commands, the grilling dependency check, the `new` flow | todo | | |
| T10.3 | Templates for config, tool, migration (RLS on by default), seed and `main.ts` | todo | | |
| T10.4 | Channel glue for WhatsApp, Telegram, Discord, web and terminal, with buttons and operator… | todo | | |
| T10.5 | `add-tool`, `swap` and `chat` | todo | | |
| T10.6 | `review`, `tune`, and exporting flagged conversations as evals-agent cases | todo | | |
| T10.7 | PowerShell and POSIX installers | todo | | |
| M10 check | C22 passes by building the demo agent from scratch with the skill. | todo | | |

## M11. Dogfood, evals and release

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T11.1 | Rebuild `examples/demo-agent` with `/openboxagent new`, keeping only what the skill wrote | todo | | |
| T11.2 | evals-agent adapter for the demo agent using only injected dependencies | todo | | |
| T11.3 | README and quickstart, tested on a fresh clone, plus a secret scan | todo | | |
| T11.4 | Trace report at zero uncovered Spec IDs; CI now fails on any gap | todo | | |
| T11.5 | Publish 0.1.0 | todo | | |
| T11.6 | Write Review.md | todo | | |
| M11 check | C20, C23, C24 and C25 pass, and Review.md is written. | todo | | |

## After release

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| C1 | Build the restaurant agent, then the dentist agent. Record every core change either needed | todo | | |
