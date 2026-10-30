# /openboxagent

The skill that builds agents on openbox-agent, for Claude Code and Codex.

Built in M10.

- `references/` - built at T10.1. `best-practices.md` is the two vendors'
  own guidance condensed, with the sources and the date they were read.
  `checklist.md` is SKILL-9's checks, each with how to check it and what
  makes it fail. `prompt-template.md` is SKILL-8's ten headings. Every
  command reads the first two before it writes anything (SKILL-2).
- `SKILL.md` - built at T10.2. The six commands, the grilling dependency
  check, the `new` flow step by step, and the personal data round that
  runs before any config is written.
- `templates/` - config, tool, migration, seed and `main.ts` starting
  points. T10.3.
- `templates/channels/` - WhatsApp, Telegram, Discord, web and terminal
  glue. T10.4.

`install/` links this directory into `~/.claude/skills/openboxagent` and
`~/.codex/skills/openboxagent` (REL-3).
