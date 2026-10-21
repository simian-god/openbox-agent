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
| T5.3 | OpenAI Agents SDK brain | BRAIN-1 |
| T5.4 | Claude Code CLI and Codex CLI brains: check the flag combinations, including spawning on Windows | BRAIN-1, Spec 23 |
| T5.5 | Fallback chain, dropping extra tool calls, refusing CLI brains in production | BRAIN-3, BRAIN-4, BRAIN-5 |
| T5.6 | Conformance suite: one scripted conversation run on all five brains. Live and opt in | C2 |

**Done when:** C2 passes.

### M6. Handover and operators

| Task | What | Spec |
|---|---|---|
| T6.1 | Operator role, `openbox operator add`, role filtering, blocking, operator tools | ROLE-2 to ROLE-4, built in tools table |
| T6.2 | Handover states and every trigger: `escalate`, `wants_human`, repeat rules | HAND-1 to HAND-3, GATE-3, LOOP-10 |
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

**Done when:** C10, C16 and C17 pass.

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
| T10.2 | `SKILL.md`: commands, the grilling dependency check, the `new` flow | SKILL-1, SKILL-3 |
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
