# openbox-agent

A core for conversational agents, built around two promises. An irreversible
action runs only if that person confirmed that exact action. A message is
never lost, never answered twice, and never answered by two servers at once.

The core handles the rest of what every agent needs and most get wrong:
routing, gating risky actions, handover to a human, scheduled messages, spend
caps and personal data rules. You bring the tools and the channel. The
`/openboxagent` skill builds an agent on it.

Status: early. You can talk to an agent from a terminal, and that is about
it. See `docs/Progress.md` for where the build has got to.

## Layout

| Path | What |
|---|---|
| `packages/core` | the npm package `openbox-agent` |
| `skill/` | the `/openboxagent` skill for Claude Code and Codex |
| `examples/demo-agent` | a one tool agent, rebuilt by the skill at M11 |
| `install/` | installers that link the skill into `~/.claude` and `~/.codex` |
| `scripts/` | `trace` for Spec ID coverage, `c8` for whether routing is worth it |
| `docs/` | Intent, Spec, Plan and Progress |

## Requirements

Bun. A Supabase project, or Docker for the local stack.

## Install the skill

Links `skill/` into `~/.claude/skills/openboxagent` and
`~/.codex/skills/openboxagent`, so `/openboxagent` works in Claude Code and
in Codex. A link, so changing this repo changes the installed skill.

```
powershell -ExecutionPolicy Bypass -File install\sync.ps1   # Windows
sh install/sync.sh                                          # macOS, Linux
```

Add `-Status` or `--status` to see what is installed, and `-Remove` or
`--remove` to take it out again. `install/README.md` has the rest.

## Quickstart

Written at M11, once there is something to start. Until then,
`examples/demo-agent/README.md` shows how to talk to the demo agent with
`openbox chat`.

## Environment

Copy `.env.example` to `.env` and fill in the keys for the providers your
config uses. No secret ever goes in config or in git.

## Licence

MIT.
