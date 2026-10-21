import { defineConfig } from "../../../src/index.ts"

// The fixture C8 is measured on. Eight tools, which is three more than
// routingMinTools, so routing actually runs and there are two arms to
// compare. The demo agent has one tool and cannot answer the question.
export default defineConfig({
  name: "routing-fixture",
  mode: "development",
  timezone: "Asia/Kolkata",
  hours: {
    mon: [
      ["11:00", "15:00"],
      ["19:00", "23:00"],
    ],
    tue: [
      ["11:00", "15:00"],
      ["19:00", "23:00"],
    ],
    wed: [
      ["11:00", "15:00"],
      ["19:00", "23:00"],
    ],
    thu: [
      ["11:00", "15:00"],
      ["19:00", "23:00"],
    ],
    fri: [
      ["11:00", "15:00"],
      ["19:00", "23:30"],
    ],
    sat: [["11:00", "23:30"]],
    sun: [["11:00", "22:00"]],
  },
  brain: { id: "openrouter", model: "anthropic/claude-haiku-4.5" },
  decisionModel: { id: "jev", route: "openrouter" },
  retriever: { id: "local" },
  limits: { dailySpendUsd: 5 },
  notice: "We store your messages so we can answer you.",
  retentionDays: 365,
})
