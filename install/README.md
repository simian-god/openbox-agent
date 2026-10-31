# install

Two installers that link `skill/` into `~/.claude/skills/openboxagent` and
`~/.codex/skills/openboxagent`, so Claude Code and Codex both find
`/openboxagent` (REL-3).

| Where | Run |
|---|---|
| Windows | `powershell -ExecutionPolicy Bypass -File install\sync.ps1` |
| macOS, Linux | `sh install/sync.sh` |

Both take the same four modes: nothing installs or repairs the links,
`-Status` or `--status` reports what is installed, `-Copy` or `--copy`
copies instead of linking, and `-Remove` or `--remove` uninstalls.

A link, not a copy, so the repo stays the one source of truth. A copy is
the failure nobody notices: change `SKILL.md`, forget to run the installer
again, and the agent reads yesterday's skill with nothing looking wrong.
Windows gets directory junctions, which need no administrator rights and no
Developer Mode.

Two things both scripts refuse. A real directory where the link goes is
left alone, because it is somebody else's work. And a link that came back
as a copy is removed rather than kept, which is what Git Bash does with
`ln -s` on a directory, so `sync.sh` tells you to use `sync.ps1` instead.

A host that is not on the machine is skipped. A host that is there with no
`skills` folder yet gets one.
