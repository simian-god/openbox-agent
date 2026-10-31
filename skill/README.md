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
- `templates/` - built at T10.3. `agent.config.ts`, `tools/tool.ts`,
  `db/migrations/0001_agent.sql`, `db/seed.ts` and `main.ts`. They parse,
  the migration applies for real with row level security on, and the
  config refuses to start until the builder's own numbers are in it.
- `templates/channels/` - built at T10.4. WhatsApp Cloud API, Telegram
  Bot API, Discord, a generic web webhook and the terminal. Each verifies
  its own webhook the way that channel documents, maps both shapes a tap
  can arrive in, and answers `capabilities` honestly rather than
  hopefully.

`install/` links this directory into `~/.claude/skills/openboxagent` and
`~/.codex/skills/openboxagent` (REL-3), built at T10.7. A link, so changing
a file here changes the installed skill. `sync.ps1` on Windows, `sync.sh`
on macOS and Linux.
