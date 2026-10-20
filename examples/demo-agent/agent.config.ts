// A one tool demo agent, for `openbox chat` and the M1 milestone check.
//
// T11.1 replaces this folder with whatever `/openboxagent new` writes, so
// nothing here is meant to be the final shape of an agent project. It is
// the smallest thing that is a real agent: a config, a prompt and a tool.
import { defineConfig } from "openbox-agent"

export default defineConfig({
  name: "demo-restaurant",
  mode: "development",
  timezone: "Asia/Kolkata",

  hours: {
    mon: [
      ["11:00", "15:00"],
      ["19:00", "23:00"],
    ],
    tue: [["11:00", "23:00"]],
    wed: [["11:00", "23:00"]],
    thu: [["11:00", "23:00"]],
    fri: [["11:00", "23:30"]],
    sat: [["11:00", "23:30"]],
    sun: [["11:00", "22:00"]],
  },

  brain: { id: "openrouter", model: "openai/gpt-4o-mini" },
  decisionModel: { id: "jev" },
  retriever: { id: "local" },

  limits: { dailySpendUsd: 1 },

  notice: "We keep your messages so we can answer you. Reply STOP to opt out.",
  retentionDays: 365,
})
