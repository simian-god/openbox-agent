# /openboxagent

The skill that builds agents on openbox-agent, for Claude Code and Codex.

Built in M10. It will hold:

- `SKILL.md` - the commands: `new`, `add-tool`, `swap`, `chat`, `review`, `tune`.
- `references/` - best practices, the build checklist, the prompt template.
- `templates/` - config, tool, migration, seed and `main.ts` starting points.
- `templates/channels/` - WhatsApp, Telegram, Discord, web and terminal glue.

`install/` links this directory into `~/.claude/skills/openboxagent` and
`~/.codex/skills/openboxagent` (REL-3).
