#!/bin/sh
# Link skill/ into Claude Code and Codex, so this repo stays the one source
# of truth and the installed skill can never drift from it (REL-3).
#
#   sh install/sync.sh             install or repair the links
#   sh install/sync.sh --status     report what is installed
#   sh install/sync.sh --copy       copy instead of linking (not recommended)
#   sh install/sync.sh --remove     uninstall
#
# A symlink is the default because a copy is the failure nobody notices:
# the day you change SKILL.md and forget to run this again, the agent
# reads yesterday's skill and nothing looks wrong.
#
# This is the script for macOS and Linux. On Windows use install\sync.ps1,
# which makes directory junctions and needs no administrator rights. Git
# Bash is not an exception: its ln -s copies a directory instead of
# linking it, which this script checks for and refuses.
set -u

mode=install

usage() {
    cat <<'EOF'
Install the /openboxagent skill for Claude Code and Codex.

  sh install/sync.sh             install or repair the links
  sh install/sync.sh --status     report what is installed
  sh install/sync.sh --copy       copy instead of linking (not recommended)
  sh install/sync.sh --remove     uninstall
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --status) mode=status ;;
        --copy) mode=copy ;;
        --remove) mode=remove ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            printf 'unknown option: %s\n\n' "$1" >&2
            usage >&2
            exit 1
            ;;
    esac
    shift
done

repo=$(cd "$(dirname "$0")/.." && pwd)
source_dir="$repo/skill"

if [ ! -f "$source_dir/SKILL.md" ]; then
    echo "No SKILL.md at $source_dir - run this from the openbox-agent repo." >&2
    exit 1
fi

if [ -z "${HOME:-}" ]; then
    echo "No HOME is set, so there is nowhere to install to." >&2
    exit 1
fi

# The two places REL-3 names, relative to the home directory.
skills=".claude/skills/openboxagent .codex/skills/openboxagent"

# What is at a path now, in the words --status reports.
describe() {
    if [ -L "$1" ]; then
        printf 'symlink -> %s' "$(readlink "$1")"
    elif [ -d "$1" ]; then
        printf 'real directory'
    elif [ -e "$1" ]; then
        printf 'a file, not a directory'
    else
        printf 'absent'
    fi
}

if [ "$mode" = status ]; then
    echo "source: $source_dir"
    for skill in $skills; do
        target="$HOME/$skill"
        printf '  %-50s %s\n' "$target" "$(describe "$target")"
    done
    exit 0
fi

failed=0

for skill in $skills; do
    client=${skill%%/*}
    root="$HOME/$client"
    target="$HOME/$skill"

    # A host that is not installed on this machine is not a problem to
    # report. A host that is installed but has no skills folder yet is
    # the normal case on a fresh machine, so that folder is made.
    if [ ! -d "$root" ]; then
        echo "skip (no $client on this machine): $root"
        continue
    fi

    if [ -L "$target" ]; then
        # Ours to replace: a link can be recreated losslessly.
        rm -f "$target"
    elif [ -e "$target" ]; then
        if [ "$mode" = remove ]; then
            echo "warning: $target is a real directory, not a link - leaving it alone." >&2
        else
            echo "refused: $target is a real directory. Move or delete it first." >&2
            echo "         This installer never overwrites files that are not its own." >&2
            failed=1
        fi
        continue
    fi

    if [ "$mode" = remove ]; then
        echo "removed: $target"
        continue
    fi

    # One target failing must not cost the other one its link, so this is
    # reported and the loop carries on.
    if ! mkdir -p "$(dirname "$target")" 2>/dev/null; then
        echo "refused: $(dirname "$target") could not be created." >&2
        failed=1
        continue
    fi

    if [ "$mode" = copy ]; then
        cp -R "$source_dir" "$target"
        echo "copied:  $target"
        echo "         This copy will drift from the repo. Run it again after every change."
        continue
    fi

    ln -s "$source_dir" "$target" 2>/dev/null

    # ln can fail, and it can also report success and leave a copy: that is
    # what Git Bash does with a directory, and some filesystems too. A copy
    # here is worse than nothing, because it goes stale in silence, so it
    # is taken away again.
    if [ ! -L "$target" ]; then
        rm -rf "$target"
        echo "refused: $target could not be symlinked, only copied, so nothing was left there." >&2
        echo "         On Windows use the PowerShell installer instead:" >&2
        echo "         powershell -ExecutionPolicy Bypass -File install\\sync.ps1" >&2
        failed=1
        continue
    fi

    echo "linked:  $target  ->  $source_dir"
done

if [ "$mode" != remove ] && [ "$failed" = 0 ]; then
    echo ""
    echo "Installed. In Claude Code the skill is /openboxagent, and Codex reads it"
    echo "from ~/.codex/skills. Check it with: sh install/sync.sh --status"
fi

exit $failed
