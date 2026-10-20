# demo-agent

A one tool agent, used to try `openbox chat` and to run the M1 milestone check.

T11.1 rebuilds this folder with `/openboxagent new`, keeping only what the skill
writes. Until then it is hand written, and it is the smallest thing that is a
real agent: a config, a prompt and one tool.

## Talking to it

From the repository root, with Docker running:

```
bun run db:up
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  bun packages/core/src/cli/index.ts migrate

SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_SERVICE_ROLE_KEY=<the service_role key from bun run db:status> \
OPENROUTER_API_KEY=<your key> \
  bun packages/core/src/cli/index.ts chat --dir examples/demo-agent
```

Then type a message. `:help` lists chat's own commands, `:trace` shows what the
last turn recorded, and `:quit` leaves.

## What is here

| File | What it is |
|---|---|
| `agent.config.ts` | the config, including opening hours |
| `prompt.md` | the system prompt, with SKILL-8's headings |
| `tools/check_opening_hours.ts` | the one tool, a `read` tool |
