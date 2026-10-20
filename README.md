# openbox-agent

A reusable core for building conversational agents, plus the `/openboxagent`
skill that builds agents on it.

The core handles the parts every agent needs and most get wrong: reliable
message handling, routing, gating risky actions, confirmation, handover to a
human, scheduled messages, spend caps and personal data rules. You bring the
tools and the channel.

Status: early. You can talk to an agent from a terminal, and that is about
it. See `docs/Progress.md` for where the build has got to.

## Layout

| Path | What |
|---|---|
| `packages/core` | the npm package `openbox-agent` |
| `skill/` | the `/openboxagent` skill for Claude Code and Codex |
| `examples/demo-agent` | a one tool agent, rebuilt by the skill at M11 |
| `install/` | installers that link the skill into `~/.claude` and `~/.codex` |
| `docs/` | Intent, Spec, Plan and Progress |

## Requirements

Bun. A Supabase project, or Docker for the local stack.

## Quickstart

Written at M11, once there is something to start. Until then,
`examples/demo-agent/README.md` shows how to talk to the demo agent with
`openbox chat`.

## Environment

Copy `.env.example` to `.env` and fill in the keys for the providers your
config uses. No secret ever goes in config or in git.

## Licence

MIT.
