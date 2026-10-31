// REL-3: the installers that put `skill/` where the two hosts look for it.
//
// Both scripts are run for real here, against a throwaway home directory,
// because the whole job of an installer is what it does to a filesystem
// and none of that can be checked by reading it.
//
// Each script is tested on the platform it is for: the PowerShell one on
// Windows, the POSIX one on macOS and Linux, and CI runs both. The one
// thing Windows proves about the POSIX script is the thing most likely to
// go wrong in silence: in Git Bash, `ln -s` of a directory makes a copy,
// and a copy of a skill goes stale the first time SKILL.md changes.
import { test, expect, describe, afterEach } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { delimiter, join } from "node:path"
import { tmpdir } from "node:os"

const ROOT = join(import.meta.dir, "..", "..", "..", "..")
const PS1 = join(ROOT, "install", "sync.ps1")
const SH = join(ROOT, "install", "sync.sh")
const SOURCE = join(ROOT, "skill")

const read = (p: string) => readFileSync(p, "utf8")
const onWindows = process.platform === "win32"

/** A home directory nobody else is using, with only these clients in it. */
const temps: string[] = []
function fakeHome(clients: string[] = []): string {
  const home = mkdtempSync(join(tmpdir(), "openbox-install-"))
  temps.push(home)
  for (const client of clients) mkdirSync(join(home, client, "skills"), { recursive: true })
  return home
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openbox-elsewhere-"))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Run {
  code: number
  out: string
  err: string
  /** Both streams, because a refusal is a refusal whichever one it used. */
  all: string
}

async function run(command: string[], env: Record<string, string>): Promise<Run> {
  const child = Bun.spawn(command, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, out, err, all: `${out}\n${err}` }
}

/** The POSIX script, with HOME pointed somewhere harmless. */
function sh(home: string, args: string[] = [], env: Record<string, string> = {}, script = SH) {
  // Git Bash understands C:/... but not C:\..., so the slashes are turned
  // round for both the script path and HOME. A backslash path would reach
  // `dirname` as one word and the script would look for the repo in the
  // wrong place. Everything asserted after this uses node's own paths.
  const forward = (path: string) => path.replace(/\\/g, "/")
  return run(["sh", forward(script), ...args], { HOME: forward(home), ...env })
}

/** The PowerShell script. It reads USERPROFILE, which is what this moves. */
function ps(home: string, args: string[] = [], script = PS1) {
  return run(
    [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...args,
    ],
    { USERPROFILE: home, HOME: home },
  )
}

const claudeSkill = (home: string) => join(home, ".claude", "skills", "openboxagent")
const codexSkill = (home: string) => join(home, ".codex", "skills", "openboxagent")

function isLink(path: string): boolean {
  return existsSync(path) && lstatSync(path).isSymbolicLink()
}

// ---------------------------------------------------------------- the files

test("REL-3: both installers ship, one for PowerShell and one for POSIX shells", () => {
  expect(existsSync(PS1)).toBe(true)
  expect(existsSync(SH)).toBe(true)

  const posix = read(SH)
  expect(posix.startsWith("#!/bin/sh")).toBe(true)
  // A CR in a shell script is a syntax error on Linux, and this repo is
  // written on Windows. .gitattributes holds the committed copy to LF;
  // this holds the working copy, which is what a builder here runs.
  expect(posix).not.toContain("\r")
})

test("REL-3: both installers link the same two skill directories", () => {
  // The exact two paths REL-3 names, read out of each script rather than
  // assumed: a Claude Code skill and a Codex skill, both openboxagent.
  const wanted = [/\.claude[\\/]skills[\\/]openboxagent/, /\.codex[\\/]skills[\\/]openboxagent/]
  for (const file of [PS1, SH]) {
    const text = read(file)
    for (const path of wanted) expect(text).toMatch(path)
  }
})

test("REL-3: both installers offer the same four modes", () => {
  const powershell = read(PS1)
  const posix = read(SH)

  // Install is the default in both, so what is checked is the other three
  // plus the header that tells a builder they exist.
  for (const flag of ["-Status", "-Copy", "-Remove"]) {
    expect(powershell).toContain(flag)
  }
  for (const flag of ["--status", "--copy", "--remove"]) {
    expect(posix).toContain(flag)
  }
  expect(powershell).toContain("sync.ps1 -Status")
  expect(posix).toContain("sync.sh --status")
})

test("REL-3: neither installer holds a path from the machine it was written on", () => {
  for (const file of [PS1, SH]) {
    const text = read(file)
    for (const path of [/[A-Z]:\\Users\\/i, /\/Users\//, /\/home\//, /Pranav/i]) {
      expect(text).not.toMatch(path)
    }
  }
})

test("REL-3: the installers are how the repo says to install the skill", () => {
  // An installer nobody is told to run leaves the skill uninstalled.
  for (const doc of [join(ROOT, "README.md"), join(ROOT, "install", "README.md")]) {
    const text = read(doc)
    expect(text).toContain("sync.ps1")
    expect(text).toContain("sync.sh")
  }
})

// -------------------------------------------------------- the POSIX script

describe("the POSIX installer", () => {
  test("REL-3: --status reports what is installed, before anything is", async () => {
    const home = fakeHome([".claude", ".codex"])
    const { code, out } = await sh(home, ["--status"])

    expect(code).toBe(0)
    // Not the exact path: in Git Bash the script's own `pwd` reports
    // /d/repo rather than D:\repo, and either one is the right answer.
    expect(out).toMatch(/^source: \S*[\\/]skill$/m)
    expect(out).toContain(".claude/skills/openboxagent")
    expect(out).toContain(".codex/skills/openboxagent")
    expect(out.match(/absent/g) ?? []).toHaveLength(2)
  }, 30_000)

  test("REL-3: --help lists the four modes and does nothing", async () => {
    const home = fakeHome([".claude"])
    const { code, out } = await sh(home, ["--help"])

    expect(code).toBe(0)
    for (const flag of ["--status", "--copy", "--remove"]) expect(out).toContain(flag)
    expect(existsSync(claudeSkill(home))).toBe(false)
  }, 30_000)

  test("REL-3: an unknown option is refused rather than guessed at", async () => {
    const home = fakeHome([".claude"])
    const { code, all } = await sh(home, ["--force"])

    expect(code).not.toBe(0)
    expect(all).toContain("--force")
    expect(existsSync(claudeSkill(home))).toBe(false)
    // A non-zero exit is not enough on its own: an install that fell
    // through and then failed would look the same. Nothing was touched,
    // so none of the words the install loop prints are here.
    for (const word of ["linked", "copied", "removed", "refused", "skip"]) {
      expect(all).not.toContain(word)
    }
  }, 30_000)

  test("REL-3: a client this machine does not have is skipped, not created", async () => {
    const home = fakeHome([".claude"])
    const { all } = await sh(home)

    expect(existsSync(join(home, ".codex"))).toBe(false)
    expect(all).toContain("skip")
    expect(all).toContain(".codex")
  }, 30_000)

  test("REL-3: a real directory at the target is refused and left alone", async () => {
    const home = fakeHome([".claude", ".codex"])
    mkdirSync(claudeSkill(home), { recursive: true })
    writeFileSync(join(claudeSkill(home), "mine.md"), "someone elses work")

    const { code, all } = await sh(home)

    expect(code).not.toBe(0)
    expect(all).toContain("real directory")
    expect(all).not.toContain("Installed.")
    expect(read(join(claudeSkill(home), "mine.md"))).toBe("someone elses work")
  }, 30_000)

  test("REL-3: a skills folder that is a file is reported, not worked around", async () => {
    const home = fakeHome()
    mkdirSync(join(home, ".claude"))
    writeFileSync(join(home, ".claude", "skills"), "not a folder")

    const { code, all } = await sh(home)

    expect(code).not.toBe(0)
    expect(all).toContain("refused")
    expect(read(join(home, ".claude", "skills"))).toBe("not a folder")
  }, 30_000)

  test("REL-3: it refuses to run away from the repo it is part of", async () => {
    const elsewhere = tempDir()
    const copy = join(elsewhere, "sync.sh")
    writeFileSync(copy, read(SH))
    const home = fakeHome([".claude"])

    const { code, all } = await sh(home, [], {}, copy)

    expect(code).not.toBe(0)
    expect(all).toContain("SKILL.md")
    expect(existsSync(claudeSkill(home))).toBe(false)
  }, 30_000)

  // The guard that matters. `ln` is replaced by one that copies, which is
  // exactly what MSYS does on Windows: the install looks fine, and then
  // the installed skill never changes again.
  test("REL-3: a copy where a link was asked for is removed, not left behind", async () => {
    const home = fakeHome([".claude"])
    const bin = tempDir()
    writeFileSync(
      join(bin, "ln"),
      '#!/bin/sh\nwhile [ $# -gt 2 ]; do shift; done\ncp -R "$1" "$2"\n',
      {
        mode: 0o755,
      },
    )

    const { code, all } = await sh(home, [], {
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
    })

    expect(code).not.toBe(0)
    expect(existsSync(claudeSkill(home))).toBe(false)
    expect(all).toContain("sync.ps1")
  }, 30_000)

  test.skipIf(!onWindows)(
    "REL-3: in Git Bash on Windows it refuses rather than leaving a copy to go stale",
    async () => {
      const home = fakeHome([".claude"])
      const { code, all } = await sh(home)

      expect(code).not.toBe(0)
      expect(existsSync(claudeSkill(home))).toBe(false)
      expect(all).toContain("sync.ps1")
    },
    30_000,
  )

  test.skipIf(onWindows)(
    "REL-3: it links both skills, and SKILL.md reads through the link",
    async () => {
      const home = fakeHome([".claude", ".codex"])
      const first = await sh(home)

      expect(first.code).toBe(0)
      for (const target of [claudeSkill(home), codexSkill(home)]) {
        expect(isLink(target)).toBe(true)
        expect(readlinkSync(target)).toBe(SOURCE)
        expect(read(join(target, "SKILL.md"))).toContain("openboxagent")
      }

      // Run twice, because the first thing anybody does after changing the
      // repo is run it again.
      const second = await sh(home)
      expect(second.code).toBe(0)
      expect(isLink(claudeSkill(home))).toBe(true)

      const status = await sh(home, ["--status"])
      expect(status.out).toContain("symlink")
    },
    30_000,
  )

  test.skipIf(onWindows)(
    "REL-3: it makes the skills folder when the client has none yet",
    async () => {
      const home = fakeHome()
      mkdirSync(join(home, ".claude"))

      const { code } = await sh(home)

      expect(code).toBe(0)
      expect(isLink(claudeSkill(home))).toBe(true)
    },
    30_000,
  )

  test.skipIf(onWindows)(
    "REL-3: --remove takes the links away and leaves a real directory alone",
    async () => {
      const home = fakeHome([".claude", ".codex"])
      await sh(home)
      expect(isLink(claudeSkill(home))).toBe(true)

      // One of the two is somebody else's folder, which --remove must not eat.
      rmSync(codexSkill(home))
      mkdirSync(codexSkill(home))
      writeFileSync(join(codexSkill(home), "mine.md"), "not ours")

      const { code, all } = await sh(home, ["--remove"])

      expect(code).toBe(0)

      expect(existsSync(claudeSkill(home))).toBe(false)
      expect(read(join(codexSkill(home), "mine.md"))).toBe("not ours")
      expect(all).toContain("removed")
      expect(existsSync(join(home, ".claude", "skills"))).toBe(true)
    },
    30_000,
  )

  test.skipIf(onWindows)(
    "REL-3: --copy copies, and says the copy will drift",
    async () => {
      const home = fakeHome([".claude"])
      const { code, out } = await sh(home, ["--copy"])

      expect(code).toBe(0)
      expect(isLink(claudeSkill(home))).toBe(false)
      expect(read(join(claudeSkill(home), "SKILL.md"))).toContain("openboxagent")
      expect(out).toContain("drift")
    },
    30_000,
  )
})

// --------------------------------------------------- the PowerShell script

describe.skipIf(!onWindows)("the PowerShell installer", () => {
  test("REL-3: -Status reports what is installed, before anything is", async () => {
    const home = fakeHome([".claude", ".codex"])
    const { code, out } = await ps(home, ["-Status"])

    expect(code).toBe(0)
    expect(out).toContain(SOURCE)
    expect(out.match(/absent/g) ?? []).toHaveLength(2)
  }, 60_000)

  test("REL-3: it junctions both skills, and SKILL.md reads through the junction", async () => {
    const home = fakeHome([".claude", ".codex"])
    const first = await ps(home)

    expect(first.err).toBe("")
    expect(first.code).toBe(0)
    for (const target of [claudeSkill(home), codexSkill(home)]) {
      // A junction is a link to node and to Windows alike, which is the
      // whole point: a copy would pass a read and then go stale.
      expect(isLink(target)).toBe(true)
      expect(read(join(target, "SKILL.md"))).toContain("openboxagent")
    }

    const second = await ps(home)
    expect(second.code).toBe(0)
    expect(isLink(claudeSkill(home))).toBe(true)

    const status = await ps(home, ["-Status"])
    expect(status.out).toContain("Junction")
    expect(status.out).toContain(SOURCE)
  }, 60_000)

  test("REL-3: a real directory at the target is refused and left alone", async () => {
    const home = fakeHome([".claude", ".codex"])
    mkdirSync(claudeSkill(home), { recursive: true })
    writeFileSync(join(claudeSkill(home), "mine.md"), "someone elses work")

    const { code, all } = await ps(home)

    expect(code).not.toBe(0)
    expect(all).toContain("real directory")
    expect(all).not.toContain("Installed.")
    expect(read(join(claudeSkill(home), "mine.md"))).toBe("someone elses work")
    // The other client is still installed: one bad target does not stop it.
    expect(isLink(codexSkill(home))).toBe(true)
  }, 60_000)

  test("REL-3: a client this machine does not have is skipped, not created", async () => {
    const home = fakeHome([".claude"])
    const { code, all } = await ps(home)

    expect(code).toBe(0)
    expect(existsSync(join(home, ".codex"))).toBe(false)
    expect(all).toContain("skip")
  }, 60_000)

  test("REL-3: it makes the skills folder when the client has none yet", async () => {
    const home = fakeHome()
    mkdirSync(join(home, ".claude"))

    const { code } = await ps(home)

    expect(code).toBe(0)
    expect(isLink(claudeSkill(home))).toBe(true)
  }, 60_000)

  test("REL-3: one host failing does not cost the other one its link", async () => {
    // A file where the skills folder goes. The point is the second host:
    // the script reports this one and carries on rather than stopping.
    const home = fakeHome([".codex"])
    mkdirSync(join(home, ".claude"))
    writeFileSync(join(home, ".claude", "skills"), "not a folder")

    const { code, all } = await ps(home)

    expect(code).not.toBe(0)
    expect(all).toContain("refused")
    expect(isLink(codexSkill(home))).toBe(true)
  }, 60_000)

  test("REL-3: -Remove takes the links away and leaves a real directory alone", async () => {
    const home = fakeHome([".claude", ".codex"])
    await ps(home)
    expect(isLink(claudeSkill(home))).toBe(true)

    rmSync(codexSkill(home), { recursive: true, force: true })
    mkdirSync(codexSkill(home), { recursive: true })
    writeFileSync(join(codexSkill(home), "mine.md"), "not ours")

    const { code, all } = await ps(home, ["-Remove"])

    expect(code).toBe(0)

    expect(existsSync(claudeSkill(home))).toBe(false)
    expect(read(join(codexSkill(home), "mine.md"))).toBe("not ours")
    expect(all).toContain("removed")
    expect(existsSync(join(home, ".claude", "skills"))).toBe(true)
  }, 60_000)

  test("REL-3: -Copy copies, and says the copy will drift", async () => {
    const home = fakeHome([".claude"])
    const { code, out } = await ps(home, ["-Copy"])

    expect(code).toBe(0)
    expect(isLink(claudeSkill(home))).toBe(false)
    expect(read(join(claudeSkill(home), "SKILL.md"))).toContain("openboxagent")
    expect(out).toContain("drift")
  }, 60_000)

  test("REL-3: it refuses to run away from the repo it is part of", async () => {
    const elsewhere = tempDir()
    const copy = join(elsewhere, "sync.ps1")
    writeFileSync(copy, read(PS1))
    const home = fakeHome([".claude"])

    const { code, all } = await ps(home, [], copy)

    expect(code).not.toBe(0)
    expect(all).toContain("SKILL.md")
    expect(existsSync(claudeSkill(home))).toBe(false)
  }, 60_000)
})
