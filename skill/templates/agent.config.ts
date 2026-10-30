// The agent's config (Spec section 19). Everything the core needs to know
// that is not a prompt, a tool or a channel.
//
// Four values in here are deliberately impossible: an empty `name`, an
// empty `notice`, `retentionDays: 0` and a negative spend cap. They are
// required and have no defaults, so a template cannot hold a hole where
// they go: a hole in a value would not parse, and a plausible sample
// would start and run on numbers nobody chose. Instead the agent refuses
// to start and names the field. Fill all four from the builder's own
// answers in the personal data round.
//
// Every hole below is written {{like_this}} in a comment, so one search
// finds any that were left.
import { defineConfig } from "openbox-agent"

export default defineConfig({
  // {{agent_name}}: short, lowercase, no spaces. It is the agent's id in
  // every table, so changing it later orphans the data it already has.
  name: "",
  // Development until the builder deploys. A CLI brain is refused in
  // production (BRAIN-4), which is the point of the switch.
  mode: "development",
  // {{timezone}}: an IANA zone, like Asia/Kolkata. Every date the agent
  // resolves and every opening hour is read in this zone, never the
  // server's.
  timezone: "Asia/Kolkata",

  // {{opening_hours}}: the days the business is open, in local time. Two
  // ranges on a day means a break in the middle. A day left out is a day
  // closed. `exceptions` are dated: holidays and one off changes.
  hours: {
    mon: [["09:00", "18:00"]],
    tue: [["09:00", "18:00"]],
    wed: [["09:00", "18:00"]],
    thu: [["09:00", "18:00"]],
    fri: [["09:00", "18:00"]],
    sat: [["10:00", "14:00"]],
    // exceptions: [{ date: "2027-01-26", closed: true }],
  },

  // {{brain}}: what writes the replies. OpenRouter is the default because
  // one key reaches every model. `fallbacks` are tried in order when the
  // primary fails (BRAIN-5), and a second provider is worth more than a
  // second model on the same one.
  brain: {
    id: "openrouter",
    model: "openai/gpt-4o-mini",
    fallbacks: [{ id: "openrouter", model: "anthropic/claude-3.5-haiku" }],
  },

  // {{decision_model}}: what routing and the gate ask. Not the brain, and
  // not a judge: it answers one question with one probability, and the
  // band that probability falls into decides (GATE-2).
  decisionModel: { id: "jev", route: "openrouter" },

  // {{retriever}}: what `search_knowledge` searches. `local` ranks in
  // process and needs nothing installed. `pgvector` ranks in the database
  // and needs its optional migration.
  retriever: { id: "local" },

  limits: {
    // {{daily_spend_usd}}: the cap in US dollars for one day. Crossing it
    // puts the agent into handover only, so it is a brake and not a
    // warning. Negative on purpose: unfilled, the agent will not start.
    dailySpendUsd: -1,
  },

  // {{first_contact_notice}}: PRIV-1's notice, sent once to somebody the
  // agent has not met. Empty on purpose: unfilled, the agent will not
  // start, because the alternative is sending a stranger a sentence the
  // builder never approved.
  notice: "",

  // {{retention_days}}: how long a conversation is kept, in days. Zero on
  // purpose: unfilled, the agent will not start, because the alternative
  // is keeping somebody's messages for a year nobody agreed to.
  retentionDays: 0,

  // {{builder_channel}}: where the weekly digest goes (LEARN-3). Left
  // out, no digest is sent and the agent says so at startup.
  // builderChannel: { channel: "telegram", channelUserId: "" },
})
