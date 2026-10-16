# Progress

The coding agent keeps this file up to date (see AGENTS.md). You don't need to track task numbers yourself.

Statuses: `todo`, `doing`, `done`, `blocked`. A milestone check row is done only when every item in that milestone's "Done when" passes.

**Next task:** T1.1

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
| T1.1 | `defineConfig` and validation, including the required spend cap, retention and notice | todo | | |
| T1.2 | `defineTool` and registration rules, zod to JSON schema, the description the brain sees | todo | | |
| T1.3 | First core migrations (`ob_people`, `ob_inbox`, `ob_turns`, `ob_messages`, `ob_events`… | todo | | |
| T1.4 | Store layer: every query scoped by `agent_id` in one place | todo | | |
| T1.5 | `Brain` interface, scripted brain, OpenRouter brain with native tools, `providersFromConfig` | todo | | |
| T1.6 | Turn v0: receive, create the person, one synchronous turn, step loop with read tools, the… | todo | | |
| T1.7 | Events table and capture, version hashing, both wired from the start | todo | | |
| T1.8 | Terminal channel and `openbox chat` | todo | | |
| M1 check | `openbox chat` against a one tool agent answers through OpenRouter, every turn writes events and a version, and TOOL-2, ROLE-1 and LOOP-8 step 5 have passing tests. | todo | | |

## M2. Reliability engine

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T2.1 | Duplicate drop on insert, `receive` returning in under 100 ms, `receiveAndWait` | todo | | |
| T2.2 | Person leases, the worker, burst merge, and turns that follow on | todo | | |
| T2.3 | Outbox: states, retries with backoff, idempotency keys, the timed out send rule | todo | | |
| T2.4 | Job loop: claim, run, retry, dedupe keys | todo | | |
| T2.5 | Integration tests: the same webhook twice, three messages in a burst, two worker processes on… | todo | | |
| T2.6 | Gate: run a minimal agent under evals-agent's harness and confirm DATA-4's conditional updates… | todo | | |
| M2 check | C13's tests pass against Postgres and under the evals-agent harness. | todo | | |

## M3. Decision model, routing and gating

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T3.1 | `DecisionModel` interface, scripted decision model | todo | | |
| T3.2 | Jev adapter, through TypeSafe and through OpenRouter, with recorded contract tests | todo | | |
| T3.3 | Check the OpenAI Decisions API's real shape, then build its adapter | todo | | |
| T3.4 | Routing: options, exposure rules, every step, fallback on failure, more than 255 options… | todo | | |
| T3.5 | Risk levels, the gate, bands per tool, failing closed, the decisions table, `gate_block` and… | todo | | |
| T3.6 | `openbox tune` v1: accuracy and thresholds from `examples/routing.jsonl` | todo | | |
| T3.7 | Measurement script for C8: one labeled set run with and without routing, reporting accuracy… | todo | | |
| M3 check | C3, C7 and C8 can be measured on the demo agent, and a decision model outage test proves GATE-4. | todo | | |

## M4. Confirmation, tasks and time

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T4.1 | Pending actions, signed Confirm and Cancel payloads, codes, expiry jobs, cancellation rules… | todo | | |
| T4.2 | Task table and built in task tools, with `missing` computed by code and idle expiry | todo | | |
| T4.3 | Time helpers with frozen clock tests across midnight, month end and timezone; opening hours… | todo | | |
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
