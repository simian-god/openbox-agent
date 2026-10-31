# Link skill/ into Claude Code and Codex, so this repo stays the one source
# of truth and the installed skill can never drift from it (REL-3).
#
#   powershell -ExecutionPolicy Bypass -File install\sync.ps1
#   powershell -ExecutionPolicy Bypass -File install\sync.ps1 -Status
#   powershell -ExecutionPolicy Bypass -File install\sync.ps1 -Copy
#   powershell -ExecutionPolicy Bypass -File install\sync.ps1 -Remove
#
# Install, report, copy instead of linking, uninstall. A link is the
# default because a copy is the failure nobody notices: the day you change
# SKILL.md and forget to run this again, the agent reads yesterday's skill
# and nothing looks wrong.
#
# Directory junctions, not symlinks: a junction needs no administrator
# rights and no Developer Mode, and Claude Code and Codex follow one just
# the same. This is the script for Windows; on macOS and Linux use
# install/sync.sh.
param(
    [switch]$Status,
    [switch]$Copy,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo "skill"

function Fail([string]$message) {
    [Console]::Error.WriteLine($message)
}

if (-not (Test-Path (Join-Path $source "SKILL.md"))) {
    Fail "No SKILL.md at $source - run this from the openbox-agent repo."
    exit 1
}

$userHome = $env:USERPROFILE
if (-not $userHome) { $userHome = $env:HOME }
if (-not $userHome) {
    Fail "Neither USERPROFILE nor HOME is set, so there is nowhere to install to."
    exit 1
}

# The two places REL-3 names, relative to the home directory.
$skills = @(".claude\skills\openboxagent", ".codex\skills\openboxagent")

# What is at a path now, in the words -Status reports.
function Get-LinkInfo([string]$path) {
    if (-not (Test-Path $path)) { return "absent" }
    $item = Get-Item $path -Force
    if ($item.LinkType) { return "$($item.LinkType) -> $($item.Target)" }
    if ($item.PSIsContainer) { return "real directory" }
    return "a file, not a directory"
}

if ($Status) {
    Write-Host "source: $source"
    foreach ($skill in $skills) {
        $target = Join-Path $userHome $skill
        Write-Host ("  {0,-50} {1}" -f $target, (Get-LinkInfo $target))
    }
    exit 0
}

$failed = 0

foreach ($skill in $skills) {
    $client = $skill.Split("\")[0]
    $root = Join-Path $userHome $client
    $target = Join-Path $userHome $skill

    # A host that is not installed on this machine is not a problem to
    # report. A host that is installed but has no skills folder yet is the
    # normal case on a fresh machine, so that folder is made.
    if (-not (Test-Path $root)) {
        Write-Host "skip (no $client on this machine): $root"
        continue
    }

    if (Test-Path $target) {
        $item = Get-Item $target -Force
        if ($item.LinkType) {
            # Ours to replace: a link can be recreated losslessly.
            $item.Delete()
        } elseif ($Remove) {
            Fail "warning: $target is a real directory, not a link - leaving it alone."
            continue
        } else {
            Fail "refused: $target is a real directory. Move or delete it first."
            Fail "         This installer never overwrites files that are not its own."
            $failed = 1
            continue
        }
    }

    if ($Remove) {
        Write-Host "removed: $target"
        continue
    }

    # One target failing must not cost the other one its link, so the work
    # is caught per host rather than ending the script.
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null

        if ($Copy) {
            Copy-Item -Recurse -Force $source $target
            Write-Host "copied:  $target"
            Write-Host "         This copy will drift from the repo. Run it again after every change."
        } else {
            New-Item -ItemType Junction -Path $target -Target $source | Out-Null

            # Checked rather than assumed, because a copy left where a link
            # was asked for goes stale in silence, which is the one outcome
            # worse than a failed install. sync.sh needs this for real, on
            # Git Bash; here New-Item either links or throws.
            if (-not (Get-Item $target -Force).LinkType) {
                Remove-Item -Recurse -Force $target
                throw "what landed there was a copy, not a link"
            }

            Write-Host "linked:  $target  ->  $source"
        }
    } catch {
        Fail "refused: $target could not be installed: $($_.Exception.Message)"
        $failed = 1
    }
}

if ((-not $Remove) -and ($failed -eq 0)) {
    Write-Host ""
    Write-Host "Installed. In Claude Code the skill is /openboxagent, and Codex reads it"
    Write-Host "from ~\.codex\skills. Check it with:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File install\sync.ps1 -Status"
}

exit $failed
