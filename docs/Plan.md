# Plan: openbox-agent

How Spec.md gets built: the architecture, the stack, the order of work, how it's tested, and what could go wrong. Tasks point at Spec IDs (like CONF-4), and milestones point at Intent's success criteria (C1 to C25).

---

## 1. How to work this plan

- **One task per coding session.** Each task is small enough to hand to a coding model on its own, with the listed Spec IDs as its brief.
- **Tests first, named by Spec ID.** For example, `test("CONF-4: rejects a confirm from another person")`. A task is done when its tests, the typecheck and the format check pass.
- **Spec changes go through Spec first.** If building shows the Spec is wrong, update Spec.md, then the code, and add a line to the decisions log at the bottom of this file. Review.md is written from that log.
- **Milestones ship.** Each one ends with something that runs, so you can stop after any milestone and still have a working core.

---

## 2. Architecture

```
            channel glue (per agent, written by the skill)
            WhatsApp · Telegram · Discord · web · terminal
                 │ Inbound                       ▲ Sender.send
                 ▼                               │
┌────────────────────────────────────────────────────────────────┐
│ openbox-agent core                                             │
│                                                                │
│  receive ──► inbox ──► worker (lease, burst merge)             │
│                          │                                     │
│                          ▼                                     │
│                        turn:                                   │
│                        prechecks ► context ► steps ► end       │
│                                               │                │
│               ┌─────────────┬────────────┬────┴──────┐         │
│               ▼             ▼            ▼           ▼         │
│            routing        brain        gate     confirm,       │
│            (decision                  (decision handover,      │
│             model)                     model)   tasks, tools   │
│                                                                │
│  outbox worker ──► Sender        job loop ──► reminders,       │
│  (retries, quiet hours,          expiries, timeouts,           │
│   window rules, opt out)         retention, digest             │
│                                                                │
│  store (supabase-js, ob_ tables)   events (table + capture)    │
└────────────────────────────────────────────────────────────────┘
        ▲ injected: brains · decision model · transcriber ·
          retriever · db · sender · clock · events
```

Three loops run in one process: the **inbox worker** (turns), the **outbox worker** (sends) and the **job loop** (everything scheduled). All three claim work through conditional updates (DATA-4), so a second process can run safely beside the first.

---

## 3. Repo layout

```
openbox-agent/
  packages/core/                the npm package openbox-agent
    src/
      index.ts                  the only public entry (PKG-1, PKG-2)
      config/                   defineConfig, validation
      tools/                    defineTool, registry, builtins/
      providers/
        brains/                 openrouter, claude-agent-sdk, openai-agents,
                                claude-code-cli, codex-cli, structured.ts
        decision/               jev, openai-decisions, questions.ts
        transcribers/           sarvam, openai
        retrievers/             local, pgvector
        embedders/              openai
      store/                    typed table access, claims, agent_id scoping
      runtime/
        agent.ts                createAgent, start, stop
        inbox.ts  worker.ts  turn.ts  context.ts
        routing.ts  gate.ts  confirm.ts  tasks.ts  handover.ts
        outbox.ts  jobs.ts  proactive.ts  limits.ts
        media.ts  knowledge.ts  time.ts  privacy.ts
        learning.ts  events.ts
      cli/                      openbox: migrate, operator, chat, tune
      testing/                  scripted brain, scripted decision model,
                                fake sender, fixed clock (exported for builders)
    migrations/                 core SQL, plus optional pgvector migration
    test/                       unit/, integration/, live/
  skill/                        /openboxagent
    SKILL.md
    references/                 best-practices.md, checklist.md,
                                prompt-template.md, eval-case-export.md
    templates/                  config, tool, migration, seed, main.ts
    templates/channels/         whatsapp, telegram, discord, web, terminal
  examples/demo-agent/          two tool demo, built by the skill (REL-1)
  install/                      sync.ps1, sync.sh (REL-3)
  scripts/trace.ts              Spec ID coverage report
  docs/                         Intent.md, Spec.md, Plan.md, Review.md
```

---

## 4. Stack

| Need | Choice | Why |
|---|---|---|
| Runtime | Bun | Constraint. evals-agent loads agents in process on Bun. |
| Language | TypeScript, strict | Constraint. |
| Package build | `bun build` for JS plus `tsc` for type declarations | Ships compiled ESM to npm with types. |
| Workspace | Bun workspaces | One repo for core, skill, example and installer. |
| Schemas | zod 4 | TOOL-1 uses it, and `z.toJSONSchema` gives brains their tool schemas without another dependency. |
| Database at runtime | supabase-js v2 | Constraint. It's the client evals-agent captures. |
| Migrations | `Bun.sql` over `DATABASE_URL` | supabase-js can't run DDL. Bun's built in Postgres client avoids adding one. `openbox migrate` ends with `NOTIFY pgrst, 'reload schema'` so the API sees new tables at once. |
| Local database | Supabase CLI local stack | Same Postgres plus API as production, on Docker. Works on Windows. |
| HTTP providers | Native `fetch` | OpenRouter, Jev and OpenAI Decisions are plain HTTP. One code path, easy to fake. |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` | Required brain. |
| OpenAI Agents SDK | `@openai/agents` | Required brain. |
| Time | chrono-node to parse phrases, Luxon for zones | chrono resolves "tomorrow 8pm" against a reference instant and timezone. Luxon gets daylight saving and zone math right. |
| Keyword search | MiniSearch | Small, well tested, in process. |
| HMAC and hashing | `node:crypto` | Built in. |
| CLI | Hand written argument parsing | Four commands don't need a framework. |
| Tests | `bun test` | Built in, fast, runs on Windows. |
| Formatting | Biome, formatter only | Keeps diffs down to real changes. No lint rules: strict TypeScript catches the bugs that matter, and nitpicks cost coding models tokens. |
| Secret scan | gitleaks | REL-2. |
| CI | GitHub Actions, Linux and Windows | You develop on Windows, so CLI spawning and installers get tested there too. |

---

## 5. Milestones

Each task lists the Spec IDs it implements. **Done when** is the bar for closing the milestone.

### M0. Foundations

| Task | What | Spec |
|---|---|---|
| T0.1 | Workspace, MIT license, README stub, `.env.example` | REL-1, REL-2 |
| T0.2 | Strict tsconfig, Biome as a formatter only (no lint rules), `bun test`, CI on Linux and Windows: typecheck, format check, tests, gitleaks. A test scans the source and fails on `fetch` or module level clients outside `providers/` | REL-2, DEP-1 |
| T0.3 | `scripts/trace.ts`: reads every Spec ID, finds tests that name it, prints the uncovered ones. CI warns now and fails from M11 | all |
| T0.4 | Supabase local stack, `bun run db:up`, an integration test helper that resets the database per file | DATA-3 |

**Done when:** CI is green, and the trace report runs and lists the Spec IDs that have no test.

### M1. Walking skeleton

| Task | What | Spec |
|---|---|---|
| T1.1 | `defineConfig` and validation, including the required spend cap, retention and notice | CFG-1, CFG-2 |
| T1.2 | `defineTool` and registration rules, zod to JSON schema, the description the brain sees | TOOL-1, TOOL-2, TOOL-3 |
| T1.3 | First core migrations (`ob_people`, `ob_inbox`, `ob_turns`, `ob_messages`, `ob_events`, `ob_versions`) with RLS on, and `openbox migrate`, which fails if any table has RLS off | PKG-4, DATA-1, DATA-3, DATA-5, DATA-6 |
| T1.4 | Store layer: every query scoped by `agent_id` in one place | DATA-1 |
| T1.5 | `Brain` interface, scripted brain, OpenRouter brain with native tools, `providersFromConfig` | BRAIN-1 (OpenRouter), DEP-3, TEST-3 |
| T1.6 | Turn v0: receive, create the person, one synchronous turn, step loop with read tools, the handler `ctx`, unknown tool rejection, reply through the sender | API-3, ROLE-1, TOOL-4, LOOP-7, LOOP-8 |
| T1.7 | Events table and capture, version hashing, both wired from the start. Event names are added as each feature lands | EVT-1 to EVT-3, LEARN-2 |
| T1.8 | Terminal channel and `openbox chat` | SKILL-6 |

**Done when:** `openbox chat` against a one tool agent answers through OpenRouter, every turn writes events and a version, and TOOL-2, ROLE-1 and LOOP-8 step 5 have passing tests.

### M2. Reliability engine

| Task | What | Spec |
|---|---|---|
| T2.1 | Duplicate drop on insert, `receive` returning in under 100 ms, `receiveAndWait` | LOOP-1, API-1, API-2 |
| T2.2 | Person leases, the worker, burst merge, and turns that follow on | LOOP-2, LOOP-3, LOOP-4, DATA-4 |
| T2.3 | Outbox: states, retries with backoff, idempotency keys, the timed out send rule | Sender contract, LOOP-11 |
| T2.4 | Job loop: claim, run, retry, dedupe keys, and a recovery sweep for turns a dead process left behind | DATA-4, PRO-1 |
| T2.5 | Integration tests: the same webhook twice, three messages in a burst, two worker processes on one database, a timed out send | C13 |
| T2.6 | **Gate:** run a minimal agent under evals-agent's harness and confirm DATA-4's conditional updates work in its SQLite world. If they don't, extend evals-agent's fake client before going further | TEST-2, Spec 23 |

**Done when:** C13's tests pass against Postgres and under the evals-agent harness.

### M3. Decision model, routing and gating

| Task | What | Spec |
|---|---|---|
| T3.1 | `DecisionModel` interface, scripted decision model | DM-2, TEST-3 |
| T3.2 | Jev adapter, through TypeSafe and through OpenRouter, with recorded contract tests | DM-1 |
| T3.3 | Check the OpenAI Decisions API's real shape, then build its adapter | DM-1, Spec 23 |
| T3.4 | Routing: options, exposure rules, every step, fallback on failure, more than 255 options, built in tools skipping routing | ROUTE-1 to ROUTE-5, DM-3, BUILTIN-1 |
| T3.5 | Risk levels, the gate, bands per tool, failing closed, the `tool_runs` and decisions tables, `gate_block` and `low_confidence` flags | GATE-1 to GATE-5, DATA-2 (`tool_runs`), LEARN-1 (part) |
| T3.6 | `openbox tune` v1: accuracy and thresholds from `examples/routing.jsonl` | ROUTE-4, LEARN-5 |
| T3.7 | Measurement script for C8: one labeled set run with and without routing, reporting accuracy, median latency and cost | C8 |

**Done when:** C3, C7 and C8 can be measured on the demo agent, and a decision model outage test proves GATE-4.

### M4. Confirmation, tasks and time

| Task | What | Spec |
|---|---|---|
| T4.1 | Pending actions, signed Confirm and Cancel payloads, codes, expiry jobs, cancellation rules, one execution per action | CONF-1 to CONF-8 |
| T4.2 | Task table and built in task tools, with `missing` computed by code and idle expiry | BUILTIN-2, BUILTIN-3 |
| T4.3 | Time helpers with frozen clock tests across midnight, month end and timezone; opening hours; Hinglish phrases arriving translated | TIME-1 to TIME-4 |
| T4.4 | `remember` and `forget_fact`, and the full runtime block | LOOP-7 |

**Done when:** C9, C14 and C15 pass with the scripted brain and decision model.

**Checkpoint:** from here, the core can run a simple agent in development on OpenRouter. It isn't ready for production until M9.

### M5. All five brains

| Task | What | Spec |
|---|---|---|
| T5.1 | Shared structured output adapter for brains without native tool calling | BRAIN-2 |
| T5.2 | Claude Agent SDK brain: check one turn structured output with no built in tools | BRAIN-1, Spec 23 |
| T5.4 | Claude Code CLI and Codex CLI brains: check the flag combinations, including spawning on Windows | BRAIN-1, Spec 23 |
| T5.5 | Fallback chain, dropping extra tool calls, refusing CLI brains in production | BRAIN-3, BRAIN-4, BRAIN-5 |
| T5.6 | Conformance suite: one scripted conversation run on every brain that is built. Live and opt in | C2 |
| T5.7 | Suite stability: find the intermittent integration stall (Known K14). Make a failing turn say what it was waiting on, prove no agent outlives its test file, then separate load from logic | Known K14, TEST-1 |

**Done when:** C2 passes on the four brains that are built, and three consecutive full `bun run check` runs are clean. M5 adds four brains and a conformance suite on top of a suite that already stalls now and then (K14), so this is the milestone to stop guessing about it.

### M6. Handover and operators

| Task | What | Spec |
|---|---|---|
| T6.1 | Operator role, `openbox operator add`, role filtering, blocking, operator tools | ROLE-2 to ROLE-4, built in tools table |
| T6.2 | Handover states and every trigger: `escalate`, `wants_human`, repeat rules | HAND-1 to HAND-3, GATE-3, LOOP-10 (the repeat rule; its timeout is T7.6) |
| T6.3 | Operator focus, word for word relay, `/` commands | HAND-4, HAND-5 |
| T6.4 | Waiting and idle timeouts as jobs | HAND-6, HAND-7 |
| T6.5 | Knowledge candidates from operator answers | HAND-8 |

**Done when:** C5, C11 and C12 pass.

### M7. Proactive messages, limits and media

| Task | What | Spec |
|---|---|---|
| T7.1 | `schedule` and `trigger`, fixed and composed messages | PRO-1, PRO-2 |
| T7.2 | Send rules: opt out, quiet hours, channel window and templates, STOP and START | PRO-3, PRO-4, LOOP-5 |
| T7.3 | Rate limit, step cap, spend tracking with the pricing table, the spend cap triggering handover | LIMIT-1 to LIMIT-3, LOOP-9 |
| T7.4 | Sarvam and OpenAI transcribers, language detection | LOOP-6, MEDIA-1, MEDIA-3 |
| T7.5 | Images and `sendFile` | MEDIA-2, MEDIA-4 |
| T7.6 | Timeouts and cancellation: the brain, the tools, and a deadline on `stop()`. One helper, used in all three places, that gives up after a set time and cancels the request rather than abandoning it | BRAIN-6 (new), LOOP-10 (the timeout), Known K3, Known K10 |

**Done when:** C10, C16 and C17 pass, and a dependency that never answers ends the turn, answers the person and lets `stop()` finish.

### M8. Knowledge

| Task | What | Spec |
|---|---|---|
| T8.1 | Loading knowledge files and chunking them | KNOW-1 |
| T8.2 | `local` retriever on MiniSearch, an optional OpenAI embedder, and blended scores | KNOW-4, DEP-2 |
| T8.3 | pgvector retriever and its optional migration | KNOW-4, DATA-3 |
| T8.4 | `search_knowledge`, and approved entries added to the index live | KNOW-2, KNOW-3, LEARN-6 |

**Done when:** C18 passes on the `local` retriever. pgvector passes on Postgres; under evals-agent it waits for sqlite-vec support.

### M9. Learning, personal data and failure paths

| Task | What | Spec |
|---|---|---|
| T9.1 | Every flag in LEARN-1, including the frustration question | LEARN-1 |
| T9.2 | Weekly digest job | LEARN-3 |
| T9.3 | Notice on first contact, retention job, erase, export, the `erase_person` tool | PRIV-1 to PRIV-4 |
| T9.4 | Failure sweep: inject a failure into each dependency in turn, then all at once | LOOP-12, GATE-4, ROUTE-5, BRAIN-5 |

**Done when:** C19 and C21 pass, plus the core side of C20 (flags raised, digest correct). **Checkpoint:** production ready core.

### M10. The `/openboxagent` skill

| Task | What | Spec |
|---|---|---|
| T10.1 | `best-practices.md`, `checklist.md`, `prompt-template.md`, condensed from Anthropic's and OpenAI's guides | SKILL-2, SKILL-8, SKILL-9 |
| T10.2 | `SKILL.md`: commands, the grilling dependency check, the `new` flow, and the personal data round | SKILL-1, SKILL-3, SKILL-11, SKILL-12 |
| T10.3 | Templates for config, tool, migration (RLS on by default), seed and `main.ts` | PKG-3, DATA-5 |
| T10.4 | Channel glue for WhatsApp, Telegram, Discord, web and terminal, with buttons and operator channels | SKILL-10, CONF-7 |
| T10.5 | `add-tool`, `swap` and `chat` | SKILL-4 to SKILL-6 |
| T10.6 | `review`, `tune`, and exporting flagged conversations as evals-agent cases. Nothing applies without the builder's approval | SKILL-7, LEARN-4, LEARN-5, LEARN-7 |
| T10.7 | PowerShell and POSIX installers | REL-3 |

**Done when:** C22 passes by building the demo agent from scratch with the skill.

### M11. Dogfood, evals and release

| Task | What | Spec |
|---|---|---|
| T11.1 | Rebuild `examples/demo-agent` with `/openboxagent new`, keeping only what the skill wrote | REL-1, C22 |
| T11.2 | evals-agent adapter for the demo agent using only injected dependencies. Run suites for C5, C9, C11, C13 and C20 under the harness | TEST-1, TEST-2, C24 |
| T11.3 | README and quickstart, tested on a fresh clone, plus a secret scan | REL-5, C25 |
| T11.4 | Trace report at zero uncovered Spec IDs; CI now fails on any gap | all |
| T11.5 | Publish 0.1.0 | REL-4, C23 |
| T11.6 | Write Review.md | |

**Done when:** C20, C23, C24 and C25 pass, and Review.md is written.

### After release

| Task | What | Spec |
|---|---|---|
| T5.3 | OpenAI Agents SDK brain, when it is worth having. One `ask` function on T5.1's adapter, plus its section 23 check. Parked at the builder's call, see Known K16 | BRAIN-1, Spec 23 |

C1 (the second agent ships with zero core changes) can only be checked by building real agents. Build the restaurant agent, then the dentist agent, and record every core change either one needed in Review.md.

---

## 6. Testing

| Layer | Runs | Covers |
|---|---|---|
| Unit | Every push, no network | Pure logic: registration rules, routing exposure, gate bands, HMAC, `missing`, time helpers with a frozen clock. |
| Integration | Every push, local Supabase in CI | Claims, duplicates, leases across two processes, outbox, jobs, erase and export. |
| Contract | Every push, recorded fixtures | Each provider adapter against saved real responses. |
| Live | Opt in with `OPENBOX_LIVE=1` | Real brains and decision models, the C2 conformance suite, the C8 measurement. |
| evals-agent | M11 and every release | Hostile multi turn cases against the demo agent: roles, confirmation, handover, delivery, learning. |

**Traceability.** `scripts/trace.ts` maps every Spec ID to the tests that name it. From M11, CI fails if any ID has no test. That makes "does the code do what the Spec says" a report, not a guess.

**Success criteria map.**

| Criterion | Proven in | How |
|---|---|---|
| C1 | After release | Second real agent, core diff empty |
| C2 | M5 | Live conformance suite |
| C3 | M3 | Same tests on both decision models |
| C4 | M1, M2 | Migrations, restart and brain swap tests |
| C5 | M6, M11 | evals-agent cases |
| C6 | M1 | Two channel test |
| C7 | M1 | Registration tests |
| C8 | M3 | Measurement script |
| C9 | M4, M11 | Integration tests plus evals-agent cases |
| C10 | M7 | Integration tests |
| C11, C12 | M6, M11 | Integration tests plus evals-agent cases |
| C13 | M2, M11 | Integration tests plus the harness |
| C14, C15 | M4 | Integration tests with a frozen clock |
| C16, C17 | M7 | Integration tests |
| C18 | M8 | Knowledge questions on both retrievers |
| C19 | M9 | Failure sweep |
| C20 | M9, M10, M11 | Flags and digest tests, a review run on real flags |
| C21 | M9 | Erase, export and retention tests |
| C22 | M10, M11 | Building the demo agent with the skill |
| C23 | M11 | Installing the published package |
| C24 | M11 | Adapter checklist under evals-agent |
| C25 | M11 | Fresh clone quickstart, secret scan |

---

## 7. Risks

| Risk | Likelihood | What we do |
|---|---|---|
| evals-agent's SQLite world can't run the conditional update claims | Medium | Checked first, in T2.6. If it fails, extend evals-agent's fake client before building on top. |
| The OpenAI Decisions API is in beta and its shape changes | High | It sits behind `DecisionModel`, with contract tests. Jev is built first. |
| Decision model accuracy too low to route on | Medium | Thresholds are measured (C8, `openbox tune`). Below the threshold, the brain sees every tool. Safety never rests on routing. |
| The Claude Agent SDK starts a Claude Code process for each call, so it's slower than a direct API call | High | Measured in M5. OpenRouter is the default production brain. A direct Anthropic API brain can be added later if needed. |
| Supabase tables without RLS are open to the public anon key | Certain without a fix | DATA-5: RLS on with no policies, and the agent runs with the service key only. |
| Two processes disagree on time, so a lease expires early | Low | Leases are 60 s and renewed. The README says to keep servers synced to network time. |
| WhatsApp template and button rules change | Medium | They're isolated in the channel glue template. Checked again at M10. |
| Scope is large for one builder | High | Milestones each ship. M4 is a usable core in development and M9 is production ready, so later milestones can slip without blocking real agents. |
| Prompt caching differs by provider | Medium | The static prompt always comes first and the runtime block after it (LOOP-7). Cache settings are added per brain adapter where the provider supports them. |
| Live test costs | Low | Live tests are opt in and kept short. |
| An agent needs far more throughput than one process gives | Medium | `workerConcurrency` is deliberately small, and scale comes from running more processes: the person lease makes that safe, since no two processes can ever hold the same person. Every query the worker runs is indexed and bounded, and nothing is held open across a turn. |

---

## 8. Known problems

Moved to `docs/Known.md`, so a workaround has one home rather than living in a
commit message. The risks table above is what might go wrong; that file is what
already has.

---

## 8. Decisions log

Every change to Spec made during the build goes here, with the date, the Spec ID, what changed and why. Review.md reads from this.

| Date | Spec ID | Change | Why |
|---|---|---|---|
| 2026-10-15 | DATA-2, DATA-5 | Core tables prefixed `ob_`; RLS switched on with no policies | No clashes with agent tables; closes the anon key hole on Supabase |
| 2026-10-15 | CONF-3, CONF-8 | Button payloads carry a verb so Cancel is signed too; cancel rules added | Payloads couldn't tell Confirm from Cancel |
| 2026-10-15 | TIME-3 | Times reach tools as English phrases, translated by the brain when needed | chrono-node can't parse Hindi or Hinglish |
| 2026-10-15 | DEP-3, PKG-2, config | `providersFromConfig` builds deps from config; tests pass their own; primary brain ID added to config | Config and deps both named providers with no rule for which wins |
| 2026-10-15 | HAND-6, PRIV-3 | Repeat alerts follow opening hours; erasure clears text and payloads | "Operator hours" wasn't defined; "anonymised" was vague |
| 2026-10-15 | DEP-1 | Enforced by a test instead of a lint rule; Biome used as a formatter only | Fewer moving parts; the requirement shows up in the traceability report |
| 2026-10-15 | DATA-5, DATA-6, SKILL-9 | RLS on for agent tables too, policies only for readers the builder names; `openbox migrate` fails on any table without RLS | Builder always uses RLS; makes it impossible to forget |
| 2026-10-16 | Plan M0 "Done when" | CI bar reworded: the trace report lists the Spec IDs with no test, rather than all of them | M0's tasks wrote real tests for DEP-1, DATA-3, REL-1 and REL-2, so the original wording could never be met without deleting work |
| 2026-10-16 | BRAIN-1, section 4 | `BrainMessage` defined: person, agent, operator, notice, tool_call and tool_result | The Brain interface used the type without ever defining it, and every adapter needs its shape |
| 2026-10-16 | DATA-2, DATA-3 | `ob_messages` and `ob_inbox` gain a `seq` sequence, and DATA-3 now allows sequences | Conversation order rested on `created_at`, so two rows in the same instant could put a reply before its question |
| 2026-10-20 | DATA-3 | `ob_events` gains a `seq` sequence too, and DATA-3's example list names it | EVT-1 calls the table a full trace, and several events in one turn share an instant, so a timestamp cannot order them |
| 2026-10-20 | LEARN-2 | A tool's `roles` join the version hash | Moving a tool between end users and operators changes what the agent will do for a given person, so it has to be a new version or a review can confuse the two |
| 2026-10-20 | Section 3 | `inFlight()` and `settled()` added to the runtime API | `receive` now returns before its turn finishes, so a test, a terminal or a shutdown needs a way to wait for work already in flight. `stop()` is T2.2 and will wait on the same thing |
| 2026-10-20 | Section 19 | `leaseSeconds`, `workerPollMs` and `workerConcurrency` added to config | LOOP-2 names a 60 second lease default with no config field for it, and the Spec never said how often a worker looks for work or how many people it may answer at once. All three are now settings rather than numbers buried in code |
| 2026-10-20 | Section 4 | SEND-1 to SEND-4 added: what the outbox does with each send outcome, why a thrown send is `unknown` and not retried, the retry schedule, and per person ordering | The Sender contract described the three outcomes but nothing said what to do with them. The `unknown` status and the `idempotentSends` capability both existed with no rule tying them together |
| 2026-10-20 | Section 19 | `sendAttempts` and `sendBackoffMs` added to config | "Retries with backoff" was in the Plan's task list and in no requirement, so there was no number anywhere |
| 2026-10-20 | Section 12 | JOB-1 to JOB-4 added: how a job is claimed and taken over, its retry policy, the recovery sweep, and keying a reply by what it answers | The jobs table had `lease` and `attempts` columns and no rule for either. The recovery sweep had no requirement at all, and it closes the one way a message could be lost outright |
| 2026-10-20 | Section 19 | `jobAttempts`, `jobBackoffMs` and `recoverAfterSeconds` added to config | Same gap as the send policy: numbers the behaviour needs, with nowhere to live |
| 2026-10-21 | DM-1, section 19 | `decisionModel` gains `route` and `model` in config | Jev is published on two routes with different keys and different model ids, and the OpenAI route is in beta. Config named only the model's id, so switching route or pinning a version needed a developer. Builder's decision |
| 2026-10-21 | ROUTE-5, section 19 | `decisionTimeoutMs` added to config, default 3000 | ROUTE-5 named a 3 second timeout as a default with no field to set it, so the number would have been buried in the core. Builder's decision |
| 2026-10-21 | DATA-2 | `ob_decisions` gains an `outcome` column and the step, next to the answers | GATE-3 asks whether this person has been Blocked twice in a row, which is a question about rows, and digging the answer out of a jsonb blob is both slow and unindexable. The outcome is also not the same thing as the answer: it is what the bands made of it, which is what a review and `openbox tune` both want |
| 2026-10-21 | DM-2, GATE-1 | The gate is a decision request of its own, not part of the step's one request | DM-2 puts every question for a step in one request. The gate cannot join it: it asks about arguments the brain has not proposed yet when routing is asked. A step that calls a write tool makes two requests, and that is inherent rather than a saving left on the table |
| 2026-10-21 | GATE-2, GATE-4 | Passing the gate on an irreversible call returns `needs_confirm`, so it does not run | GATE-4 says an irreversible call always needs a structured confirm, and CONF-1's pending actions are M4. Rather than let one run on a confident yes, the call does not run and the brain is told a confirmation is required. M4 turns that into a real pending action |
| 2026-10-21 | Plan M7 | T7.6 added: timeouts and cancellation for the brain and the tools, and a deadline on `stop()` | A turn waits on three outside things and only the decision model had a time limit. A brain that never answers leaves the turn running, and `stop()` waits for turns in flight, so a deploy will not drain. Observed in T2.5, written down as Known K3, and in no row until now. LOOP-10's timeout half moves here from T6.2, which keeps its repeat rule, because the three timeouts are one piece of code in three places. K10's abort signal lands here too, since cancelling is the same work. The brain's limit becomes `brainTimeoutMs` in config and needs a number from the builder when the row is worked |
| 2026-10-21 | ROUTE-4 | tune aims at a miss rate the builder chooses, 1 in 100 by default, and recommends the lowest threshold inside it | Narrowing can only hurt one way: the model was confident and the right tool was not among the few it showed. So the threshold is a price, and the builder sets what they will pay. Tuning for best top pick accuracy was the other option and optimises the wrong thing: it can choose a threshold that hides the right tool in exactly the cases the model gets wrong. Demanding zero misses was the third, and one odd example can push it near 1.0, which switches routing off while still paying for it. Builder's decision |
| 2026-10-21 | LEARN-5 | The labeled set is every tool's own `should` and `shouldNot` examples, plus `examples/routing.jsonl` when it exists | TOOL-2 refuses to register a tool without examples, so an agent already has labeled routing data on the day it is written. Reading only the file, which was the Spec's literal wording, would leave tune doing nothing for weeks while the threshold stayed at a default nobody measured. A reviewed line wins over a tool's own example for the same conversation, because it is what really happened. Builder's decision |
| 2026-10-21 | ROUTE-4, LEARN-7 | tune reports, and edits `agent.config.ts` only with `--write` | ROUTE-4 says tune "sets" the threshold and LEARN-7 says nothing changes the agent without the builder's approval. LEARN-7 wins, and `--write` is the approval. It replaces one number and refuses to restructure a config that does not already have the field. Builder's decision |
| 2026-10-21 | LEARN-5 | A `routing.jsonl` line is the short form or the full form | `{ "text", "tool" }` is what a builder writes by hand. `{ "messages", "batch", "tool" }` is for when the right tool depends on what came before, which is the case routing most often gets wrong and the one a single message cannot express. Supporting only the short form would leave those out; only the full form would make reviewing flagged conversations more tedious than it already is. Builder's decision |
| 2026-10-21 | LEARN-5 | tune asks once per distinct question, not once per label | Two labels about the same conversation for the same role are one question: same options, same state. Six tools listing "hello" under `shouldNot` are six labels and one request. Found while testing, where twelve examples turned out to be seven questions, and the report says when answers were shared so the bill is never a surprise |
| 2026-10-21 | C8 | C8 is measured on one step, not a whole turn, with the two arms interleaved | Routing changes exactly one thing, the tool list the brain is shown, and the rest of a turn costs the same either way. Adding the database and the outbox to both arms would move both medians by the same amount and tell us less. Interleaved, so a slow minute on the provider hits both arms rather than whichever ran second |
| 2026-10-21 | C8 | The routed arm is charged for its own decision request, in time and in money | Routing buys a shorter tool list on the brain call and pays a decision request for it. Leaving that out would make routing look free, and whether the trade comes out ahead is the only question bar 2 asks |
| 2026-10-21 | C8 | Bar 2 cannot pass unless the brain reported what it charged | It is a question about money, and a brain that reports no cost cannot answer the money half. It would fail either way, but failing with two zeroes side by side reads like a measurement. Catches the scripted fake and a real provider that leaves cost out of its usage object, which has nothing to fall back on until the pricing table lands at LIMIT-3 |
| 2026-10-21 | C8 | `bun run c8` says what it would spend and waits for `--go` | Two real brain calls per labeled example, which on the fixture is 98 of them. This is the expensive script in the repo, so it prints the plan and stops. `openbox tune` asks a cheap decision model once per example and just runs |
| 2026-10-21 | C8, Plan M3 | C8 is measured on a fixture agent, `packages/core/test/fixtures/routing-agent` | C8 compares the same turns with and without routing, and routing only runs above `routingMinTools` tools (ROUTE-1). The demo agent has one tool, so it cannot answer the question at all. Eight tools across all three risk levels, with their own labeled set. The demo agent is rebuilt by the skill at T11.1 and C8 can move onto it then, which is Known K13 |
| 2026-10-22 | Plan M3 | The M3 check stays blocked on C8 rather than having its bar reworded | Three of the four items pass. C8 cannot be measured on the demo agent because it has one tool, which is Known K13 and closes at T11.1. Rewording the bar to say "on a fixture" would have closed the row and lost the reminder, so the row stays `blocked` and `bun run m3-check` is in the repo to re-run it. Builder's decision |
| 2026-10-22 | CONF-8, LOOP-7 | A resolved confirmation becomes a notice, and the brain tells the person | The core resolves the tap, runs the action and writes what happened into the conversation as a notice, then the turn runs as usual. So the reply fits the conversation and can answer a follow up in the same breath. The alternative was a fixed line from the core, which is free and instant and reads like a receipt. Costs one brain turn per confirmation. Builder's decision |
| 2026-10-22 | CONF-6 | One pending action per person at a time, until tasks exist | CONF-6 keys cancellation on the task, and ob_tasks is T4.2. Until then a new pending action cancels whatever was pending for that person. Nobody is asked to confirm two things at once, and a typed four digit code is never ambiguous. Builder's decision |
| 2026-10-22 | CONF-3 | `OPENBOX_SECRET` is required only for an agent that has an irreversible tool | Nothing else signs anything, and an agent that can only read should not need a secret to start. Checked at createAgent, so a missing secret is found at startup rather than at the moment a person is first asked to confirm something |
| 2026-10-22 | CONF-1 | A pending action expires through its own scheduled job, not a sweep | One job per action, keyed on the action id, so JOB-1's dedupe makes it exactly once and it fires when it is due rather than whenever a sweep next looks. The expiry is a conditional update from pending, so an action confirmed a second before its job runs is not expired out from under the person |
| 2026-10-22 | API | `agent.confirmations` is on the public Agent | CONF-5's claim can only be proven by resolving one action twice at once, and the person lease deliberately stops that happening through `receive`. An evals adapter wanting to resolve a pending action without a channel needs the same door. Found while probing: without this the conditional claim was untestable, and the probe that removed it changed nothing |
| 2026-10-22 | BUILTIN-3, section 19 | `taskTypes[].idleHours` defaults to 24 | BUILTIN-3 names 24 hours as the default and the schema required the number with no default, so every task type carried a figure the builder had no basis to choose |
| 2026-10-22 | TOOL-2, BUILTIN-1 | `defineBuiltinTool` is a second door, and it insists the name is one of section 10's | `defineTool` refuses a built in name, which is right and which the core's own task tools would fall foul of. A flag on `defineTool` would have weakened the check it exists for. This one refuses anything section 10 does not list, so nothing can smuggle an ordinary tool through and have it exposed on every step without routing. Tools now carry `builtin`, and the registry keeps the two kinds apart |
| 2026-10-22 | LEARN-2 | The version hash stays over the builder's own tools, not the built ins | `registry.all()` is what LEARN-2 hashes. A built in tool's wording is the core's business and the core package version is already in the hash, so including them would change every existing agent's version for no new information |
| 2026-10-22 | BUILTIN-2 | The task tools exist only for an agent that declares task types | Four tool schemas on every brain call is a real cost, and an agent with nothing multi turn to track cannot use them. An agent with `taskTypes: {}` is offered none of them |
| 2026-10-22 | BUILTIN-2 | A field the task type does not declare is refused, not stored | `missing` is computed from the type's required fields, so a field the type has never heard of is one it can never account for. Storing it would make a task look fuller than it is. The refusal names the fields the type does have, so the brain can put it right on the next step |
| 2026-10-22 | BUILTIN-3 | A task's idle expiry is one job per expiry time, keyed on the time | Every change pushes the window out, and a dedupe key cannot be rescheduled. So each change queues a job whose key carries the new time, and an older job that comes due finds the task no longer idle and does nothing. No new machinery, and the same shape as CONF-1's expiry |
| 2026-10-22 | TIME-2, TIME-3 | A bare weekday is acted on; "next friday" is asked about | chrono marks a bare weekday as an inferred day, and treating every inferred day as ambiguous would have the agent asking "which Friday?" every time somebody named one. What makes a bare weekday safe is not certainty, it is that the answer is read back: the tool returns `format(at)`, and anything irreversible shows the same date in its confirm summary first. "next friday" is genuinely two things in English, so that one offers both |
| 2026-10-22 | TIME-1, TIME-2 | chrono is used as a phrase to components parser, never for its own Date | Found by running it: chrono resolves against the process's local timezone, so "in 2 hours" gives a different answer on a server in UTC than on a laptop in India. It is handed a reference expressed as the agent's wall clock, and only `get` and `isCertain` are read. `result.date()` is never called, because that is the call that would quietly put the server's zone back in |
| 2026-10-22 | TIME-3 | A partly understood phrase is ambiguous, not confidently wrong | Also found by running it: "the 31st at 9" comes back as "at 9" on today's date, with the 31st dropped and no sign except the `text` field. A confident wrong date is the worst answer a time helper can give, so a leftover that still looks like part of a date makes the whole phrase ambiguous |
| 2026-10-22 | TEST-3 | `fakeToolContext` joins the testing kit | Nine tests hand built a `ToolContext` object literal and all nine broke the day `ctx.time` arrived. Every agent builder will write tool tests, so they would have hit the same thing on the next field the core adds |
| 2026-10-22 | section 10 | A fact's key is normalised before it is stored | Lower case, underscores, nothing else. Without it "Allergies", "allergies" and "allergy " are three facts, and a brain will write all three over a long conversation and then read them back as though they were different things. The unique constraint is on the normalised key, so remembering the same thing twice updates it |
| 2026-10-22 | section 10 | `remember` refuses rather than truncates, and has a limit per person | A value cut off halfway reads as a whole fact on every later turn and nothing downstream can tell something was lost. 500 characters, and 50 facts per person, with an update always allowed so a correction is still possible when the agent knows the most about somebody |
| 2026-10-22 | section 10 | `remember` and `forget_fact` are built for every agent, unlike the task tools | The task tools need declared task types, so an agent with none is offered none. There is nothing to declare for a fact: every agent talks to people, and somebody saying they are allergic to peanuts has said something worth keeping whatever the agent is for |
| 2026-10-22 | TOOL-4 | `ctx.facts` is frozen, and is the turn's view rather than a live one | One turn, one view of the person, so a step cannot behave differently depending on whether an earlier step in the same turn remembered something. Frozen, so the only way to change a fact is `remember`, which is the only path that normalises a key |
| 2026-10-22 | TOOL-4, CONF-4 | `contextFor` is async, so a confirmed tool sees the same person a stepped tool sees | Reading the facts needs a query. A handler that saw them when run inside a step and not when run from a confirmation would differ on the one path nobody would think to test |
| 2026-10-22 | Plan M5 | T5.7 added: K14 gets a row rather than a rerun, and M5's bar gains three clean runs | Every deliberate probe in this repo reads a failure as evidence, so a suite that fails on its own occasionally devalues all of them and trains us to rerun. It sits in M5 because M5 adds four brains and a conformance suite to a suite that already stalls, which is the worst time to still be guessing. Builder asked for it to be written down rather than fixed on the spot |
| 2026-10-22 | Plan M4 | The M4 check names the test that proves each clause rather than asserting the same things again | C9, C14 and C15 are claims about behaviour, and the suite already asserts that behaviour. A check that asserted it a second time would be a second implementation to keep in step, and the first time the two disagreed nobody would know which was right. `bun run m4-check` reads the JUnit report, so it can only fail by a clause losing its test, which is the thing worth catching. Proven by renaming a test and watching it say so |
| 2026-10-26 | BRAIN-2 | `structuredBrain` takes one function each brain supplies, rather than four adapters sharing helpers | The Claude Agent SDK, the OpenAI Agents SDK and both CLI brains all need the same schema, the same prompt block, the same reader and the same retry. A wrapper that turns a text producing call into a whole `Brain` means T5.2 to T5.4 each write one function, a fix to the reader fixes four brains, and a difference between them is a difference in one place |
| 2026-10-26 | BRAIN-2 | `tool` is an enum of the offered names, and `args` is a free object | The enum means the provider refuses an invented tool before it reaches us, so C8's first bar costs nothing. A schema per tool would need a union and structured output support for unions varies by provider (Spec section 23). It is also unnecessary: LOOP-8 step 6 checks the arguments against the tool's own zod schema one step later, whatever the brain is |
| 2026-10-26 | BRAIN-2 | The reader reads past fences, prose and an array wrapper | Models fence JSON, apologise before it and explain after it however firmly they are told not to. Refusing those would mean falling back to another brain over formatting, which costs a person their answer for nothing. The object is found by balancing braces, so a nested object survives and a brace inside a string does not end it early |
| 2026-10-26 | BRAIN-2, BRAIN-5 | A tool name that was not offered is a shape failure, not an unknown tool | The brain was handed an enum of exactly what it could call, so getting it wrong says the shape was not followed. LOOP-8 step 5 exists for a brain that calls what it was not shown, and this never reaches it. One retry carries the reason, which is what makes BRAIN-5's "twice in a row" twice rather than once |
| 2026-10-26 | LIMIT-3 | Both attempts are counted when the shape fails once | Both were paid for. A turn that reported only the successful call would understate what it cost, and the spend cap reads that number |
| 2026-10-26 | SKILL-3, SKILL-11, SKILL-12 | `new` asks about personal data, and writes down that it was the builder's answer | `notice` and `retentionDays` are required with no defaults, so the skill cannot write a config without asking and the Spec never said what it asks. The grilling session is also the only moment a human is certainly present and thinking about this agent's domain. Health, financial, ID and children's data get a stop and a plain sentence that the answer belongs to a lawyer, because a skill that quietly accepted a number would leave the builder feeling they had discharged a duty. `docs/privacy.md` records what was decided and that nobody checked it, so the lawyer conversation has something to read. Builder's idea |
| 2026-10-26 | BRAIN-1, Spec 23 | The Claude Agent SDK stays an `api` brain even though it spawns a subprocess | Confirmed at T5.2 rather than suspected: it starts its own bundled executable per call. It needs no separately installed command though, and BRAIN-4 exists to keep a brain that drives the builder's own tooling out of production. So `api` stands, the Plan's latency risk row is now a measurement rather than a guess, and OpenRouter stays the default production brain |
| 2026-10-26 | Spec 23 | Three of the SDK's defaults are overridden, and two of them fail silently | `settingSources` loads `~/.claude/settings.json`, the project's settings and CLAUDE.md unless passed `[]`, so an agent's answers would otherwise depend on whose machine it ran on. `env` replaces the subprocess environment rather than merging, so passing a key alone takes `PATH` away. And the SDK's own docs say its list of built in tool names is incomplete and "cannot stand for every tool", so tools are denied with an empty allow list rather than a deny list |
| 2026-10-26 | BRAIN-1 | The subprocess runs on Bun by default | The core only runs on Bun, which is a constraint rather than a preference, so Bun is the one runtime guaranteed to be on the machine. Letting the SDK choose would mean a brain that works in development and cannot start on a server without node |
| 2026-10-26 | BRAIN-2 | The SDK's structured output is handed to the shared reader, not trusted | It arrives as an object and is stringified so the same reader validates it on the same rules as every other brain. One reader means a tool that was never offered is caught the same way everywhere, rather than trusted because this particular SDK produced it |
| 2026-10-26 | BRAIN-1, C2, Plan M5 | The OpenAI Agents SDK is parked, and C2's bar becomes the brains that are built | The builder's call, on usage limits and reasoning quality. It costs less than it reads: OpenRouter already reaches OpenAI's models, so what is parked is one vendor specific code path rather than access to GPT, and the OpenAI Decisions API is a separate dependency that stays built and tested. BRAIN-5's fallback chain still has two production brains. C2 is reworded rather than left failing because the blocker is a vendor improving, which has no date, and a milestone that cannot close would hold M6 to M9 behind it. Intent's goal 2 still names five and is never edited, so the gap stays visible there and in Known K16. T5.3 moves to After release |
| 2026-10-26 | BRAIN-1, Spec 23 | `--bare` always, so a CLI brain needs a key and never runs on a subscription | `claude --bare` is what keeps the machine out of the answer: no CLAUDE.md, no hooks, no plugins, no LSP. It also says Anthropic auth is strictly `ANTHROPIC_API_KEY` and that OAuth and the keychain are never read. So the flag that makes the brain isolated is the same flag that removes the free subscription path. Taken anyway, at the builder's call: what you test is then what you ship. It does mean a CLI brain bills like an API brain |
| 2026-10-26 | BRAIN-1 | Codex keeps its own login, and a key is passed only when one is set | The opposite of Claude's situation, and reflected rather than made uniform. `--ignore-user-config` ignores its config file without touching its auth, so a logged in Codex works with no key at all. Making both brains demand a key would have invented a rule neither command has |
| 2026-10-26 | BRAIN-2 | A CLI's envelope is opened by looking for the answer's shape, not for a field name | Found by a failing test: the envelope's field names collide with the answer's. A bare `{"kind":"reply","text":"..."}` has a `text` field, and reading `text` returned the reply as though it were the whole answer, which then failed to parse. Searching for an object whose `kind` is reply or tool is both safer and survives an envelope being renamed in a later release |
| 2026-10-26 | BRAIN-1 | Codex gets its own temp directory per call | Its schema is a file and its answer is written to a file. One shared path would mostly work and fail under load, with one call reading another's answer, which is the worst way for it to fail |
| 2026-10-26 | BRAIN-5 | Any error moves to the next brain, not only a `BrainError` | It used to rethrow anything else, on the reasoning that a fallback would mask a bug in an adapter. But the person loses their answer either way, and the bug is not hidden: the brain, the error and the fallback all go in the trace. A slower answer beats no answer. Found while reading BRAIN-5's own wording, which says "an error" and not "a provider error" |
| 2026-10-26 | LOOP-12 | A turn that nobody was answered by leaves its inbox rows findable | Making any error fall back meant a turn could end unanswered without throwing, and the row was then marked done, which breaks the rule the same file already stated. `brains_failed` and `step_cap` now leave it `failed`. `no_reply` does not: the brain chose to say nothing, and marking that failed would have the recovery sweep answer one message twice |
| 2026-10-26 | BRAIN-3 | A dropped tool call is named in the trace beside the one that ran | EVT-2's list of event names is held to the Spec by a test, and inventing one for this would have been a Spec change for something that belongs on an existing event anyway. `tool_ran` carries `dropped`, which says "this ran, and these were asked for alongside it". The extras are not queued either: the brain asked for them without having seen the first one's result, so LOOP-8 step 10 gives it that result and lets it ask again |
| 2026-10-26 | PKG-1, BRAIN-1 | The Claude Agent SDK is an optional peer dependency, not a dependency | Its platform binary is about 289 MB, and as a plain dependency every agent built on this core downloaded it to run on OpenRouter. The import was already lazy, so the code needed no change beyond an error that names the install command. A peer dependency rather than an optional one, because an optionalDependency is still installed by default, which is the thing being avoided. A repo test holds both halves: not in `dependencies`, and imported dynamically by exactly one file, since a static import would load it at startup whatever package.json said. The builder spotted the redundancy between this brain and the CLI one, which is what sent me looking |
| 2026-10-26 | C2 | The conformance suite ships in the package, and judges the trace rather than the wording | It is the thing that decides whether a brain is good enough to run an agent, so an agent builder needs it as much as this repo does: `runConformance` sits in `src/testing` beside the scripted brain and the fake sender, and a builder can put their own config through the same bar before they swap a brain. Judging the trace is what makes one conversation comparable across brains at all: no two brains word a reply the same way, so a check on wording would measure prose. The one exception is deliberate, and it is the check that matters most: a reply about the menu has to contain a word that could only have come from the tool result |
| 2026-10-26 | C2 | A check is a `must` or a `note`, and a gate in the Confirm band gets one second ask | A single pass or fail would have made honest difference into failure: whether a brain asks a question back, which band the gate landed in. Those are notes, recorded and never fatal. The gate needed more than that, because a Confirm band is the gate working rather than the brain failing, so the run says yes once, as a person would, and only then reports that the booking never happened. That keeps the bar a bar: a pair that cannot complete a booking in a straight conversation has not conformed, whichever half of it hesitated |
| 2026-10-26 | C2 | Killing the primary brain is injected, as a wrapper whose id gains `-primary` | A real outage cannot be scheduled, and C2's second half is explicitly a kill mid conversation. The fallback is usually the same brain again, so without the suffix the check that the fallback answered could not tell the two apart and would pass whatever happened |
