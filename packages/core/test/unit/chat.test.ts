// SKILL-6: what `openbox chat` changes about the agent it runs.
//
// The rest of the command is proven end to end in
// test/integration/chat.test.ts, against a real database.
import { test, expect } from "bun:test"
import { chatConfig } from "../../src/cli/chat.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"

const config = (over: Record<string, unknown> = {}): OpenboxConfig =>
  defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: [["11:00", "23:00"]] },
    brain: { id: "openrouter", model: "test/model" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages.",
    retentionDays: 365,
    ...over,
  })

test("SKILL-6: chat runs with the burst window at zero", () => {
  // A typed line is answered at once. Waiting three seconds to see whether
  // more is coming is right for WhatsApp and wrong for a terminal.
  expect(config().burstWindowMs).toBe(3000)
  expect(chatConfig(config()).burstWindowMs).toBe(0)
})

test("SKILL-6: chat changes nothing else about the config", () => {
  const original = config({ burstWindowMs: 500, maxSteps: 4 })
  expect(chatConfig(original)).toEqual({ ...original, burstWindowMs: 0 })
})
