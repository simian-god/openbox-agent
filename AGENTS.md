# openbox-agent

A reusable core for building conversational agents, plus the `/openboxagent` skill that builds agents on it.

This file is the single source of rules for coding agents. Codex reads it directly, and Claude Code reads it through CLAUDE.md. Edit this file, never CLAUDE.md.

## Docs

- `docs/Intent.md`: why this exists, goals, success criteria. Never edit it.
- `docs/Spec.md`: what the core does. Every requirement has an ID like CONF-4.
- `docs/Plan.md`: how it gets built. Milestones, tasks, stack, risks, decisions log.
- `docs/Progress.md`: the status of every task. You keep it up to date.
- `docs/Known.md`: problems we are living with, and why. A workaround belongs here so it is not rediscovered as a mystery. A row leaves it when it is resolved, not when it is worked around.

Read only the parts your task needs, not every doc in full.

## How to work

- **Start of every session:** open `docs/Progress.md`. Unless I name a task, take the first row that isn't `done`. A row marked `doing` or `blocked` comes first: tell me its note before carrying on. Mark your row `doing`.
- Do one row at a time. Read that task's row in Plan.md and every Spec ID it lists.
- Write tests first. Name each test after the Spec ID it proves, like `test("CONF-4: rejects a confirm from another person", ...)`.
- A task is done when its tests pass and the typecheck, format check and full test suite are green.
- **Milestone check rows:** run every item in that milestone's "Done when" in Plan.md and report pass or fail for each. Mark the row `done` only if all of them pass.
- **End of every task:** in Progress.md, set the row to `done` with today's date and a one line note, and update the "Next task" line. Then commit the code and Progress.md together, with a message starting with the task ID, like `T1.3: core migrations with RLS`.
- **If you can't finish:** set the row to `blocked`, write the reason in its note, commit what's safe to keep, and stop.
- Stop when the row is done. Tell me in plain words what you built, what the tests prove, and anything you were unsure about. Don't start the next row until I say so.
- If I ask "where are we?", answer from Progress.md: the current milestone, what's done, what's next, and anything blocked.

## Rules

- Spec is the source of truth. If it's wrong, unclear or impossible to build as written, stop and tell me before writing code. Once I agree, update Spec.md and add a row to the decisions log at the bottom of Plan.md.
- I'm not a developer. When a technical choice comes up that the Plan doesn't already settle, explain the options in plain language, what each one helps with and what it costs, then wait for my decision. Only choose yourself if I tell you to.
- The core reaches the outside world only through injected providers (DEP-1). No `fetch` and no module level clients outside `packages/core/src/providers/`.
- Safety critical logic (gating, confirmation, delivery guarantees, handover) lives in the core and is tested there.
- Every table gets RLS switched on (DATA-5).
- Never commit secrets. Keys come from the environment and are listed in `.env.example`.
- Use only the dependencies in Plan section 4. Ask before adding any other.
- For anything in Spec section 23, check the real docs or API before building on it, and tell me what you found.
- Writing style for docs and messages: short, plain sentences, no em dashes.

## Commands

- `bun install` - install the workspace.
- `bun run check` - typecheck, format check and the full test suite. A task is done when this is green.
- `bun run typecheck` - strict TypeScript, no emit.
- `bun run format` - rewrite files with Biome. `bun run format:check` only reports.
- `bun test` - the test suite.
- `bun run trace` - which Spec IDs have a test and which do not. Add `--covered` to list the proven ones, `--strict` to exit non zero on any gap. CI warns today and goes strict at M11.

Database, needing Docker:

- `bun run db:up` - start the local Supabase stack. Postgres on 54322, the API on 54321, Studio on 54323.
- `bun run db:down` - stop it. `bun run db:status` shows what is running.

Integration tests use that database and reset it per file. With no database running they skip, so `bun test` stays green without Docker.

Talking to the demo agent, which needs the database and an OpenRouter key:

- `bun packages/core/src/cli/index.ts chat --dir examples/demo-agent` - the terminal channel. `examples/demo-agent/README.md` has the environment it needs. Inside chat, `:help` lists its commands.
