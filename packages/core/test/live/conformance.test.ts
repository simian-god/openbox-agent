// C2, for real: the same conversation on every brain that is built.
//
// "One agent runs the same scripted conversation on all the brains,
// switching by config only, and passes the same tests on each." The suite
// itself is proven offline in test/integration/conformance.test.ts, on
// brains that cannot fail for a reason outside it. This file is the part
// that reading cannot do: whether a real model, given the core's prompt
// and two tools, actually behaves.
//
// Switching by config only is literal here. The brain entry is the one
// thing that differs: the config, the prompt, the tools, the gate and the
// conversation all come from `conformanceConfig` and `runConformance`, and
// the brains are built from that config by `providersFromConfig`.
//
// Opt in, slow and not free. It needs the local database, OPENBOX_LIVE=1,
// and OPENROUTER_API_KEY for the decision model the gate asks, whichever
// brain is under test:
//
//   OPENBOX_LIVE=1 bun test packages/core/test/live/conformance.test.ts
//
// A CLI brain spawns a process per step, so one of those runs takes
// minutes. Each brain is its own test, so a failing one names itself.
import { test, expect, beforeAll, beforeEach } from "bun:test"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { migrate } from "../../src/migrate/index.ts"
import { conformanceConfig, runConformance } from "../../src/testing/conformance.ts"
import { providersFromConfig } from "../../src/providers/index.ts"
import { DEFAULT_CLAUDE_MODEL } from "../../src/providers/brains/claude-agent-sdk.ts"
import { DEFAULT_CLAUDE_CLI_MODEL, DEFAULT_CODEX_MODEL } from "../../src/providers/brains/cli.ts"
import type { BrainId } from "../../src/config/index.ts"
import { envOr } from "../../src/env.ts"

const live = process.env["OPENBOX_LIVE"] === "1"
const openrouterKey = process.env["OPENROUTER_API_KEY"] ?? ""
const anthropicKey = process.env["ANTHROPIC_API_KEY"] ?? ""

/**
 * The gate asks the decision model, so every run needs one. Jev on the
 * OpenRouter route is the one most agents can use (Known K8), which makes
 * this key the price of entry even for a run on another brain.
 */
const canAsk = live && openrouterKey !== ""

interface Candidate {
  id: BrainId
  model: string
  /** False when this machine cannot run it, with a reason for the log. */
  ready: boolean
  why: string
}

const CANDIDATES: Candidate[] = [
  {
    id: "openrouter",
    model: envOr("OPENBOX_LIVE_MODEL", "openai/gpt-4o-mini"),
    ready: openrouterKey !== "",
    why: "OPENROUTER_API_KEY is not set",
  },
  {
    id: "claude-agent-sdk",
    model: DEFAULT_CLAUDE_MODEL,
    ready: anthropicKey !== "",
    why: "ANTHROPIC_API_KEY is not set",
  },
  {
    // BRAIN-1: `claude --bare` never reads a logged in session, so this
    // one needs a key as much as the SDK does.
    id: "claude-code-cli",
    model: DEFAULT_CLAUDE_CLI_MODEL,
    ready: anthropicKey !== "",
    why: "ANTHROPIC_API_KEY is not set, and --bare never reads a session",
  },
  {
    // Codex runs on its own login rather than a key, so there is nothing
    // to check for. Its own switch, as in the other Codex live test.
    id: "codex-cli",
    model: DEFAULT_CODEX_MODEL,
    ready: process.env["OPENBOX_LIVE_CODEX"] === "1",
    why: "OPENBOX_LIVE_CODEX is not 1",
  },
]

describeDatabase("C2: the conformance conversation on a real brain", (sql) => {
  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  // Every brain uses the same person, so one run must not find the
  // previous run's pending action.
  beforeEach(async () => {
    await resetDatabase(sql())
  })

  for (const candidate of CANDIDATES) {
    const skip = !canAsk || !candidate.ready
    if (skip && live) console.log(`skipping ${candidate.id}: ${candidate.why}`)

    test.skipIf(skip)(
      `C2: ${candidate.id} runs the whole conversation`,
      async () => {
        const config = conformanceConfig({ id: candidate.id, model: candidate.model })
        const { brains, decisionModel } = providersFromConfig(config)

        const report = await runConformance({
          config,
          brains,
          decisionModel,
          db: localSupabase(),
          log: (line) => console.log(`  ${line}`),
        })

        console.log(
          `\n  ${report.brain} (${report.model}): ${report.passed ? "passed" : "FAILED"}, ${
            report.checks.length
          } checks, $${report.costUsd.toFixed(4)}`,
        )
        for (const check of report.checks) {
          if (check.kind === "note" || !check.passed) {
            console.log(`  ${check.passed ? "note" : "FAIL"}  ${check.name}: ${check.detail}`)
          }
        }

        expect(report.failed).toEqual([])
      },
      900_000,
    )
  }
})
