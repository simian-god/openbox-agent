// The provider IDs config may name. Adapters for these arrive across M1 to
// M8; the list is here so a typo in config is caught at start rather than
// at the first message.

/** BRAIN-1. */
export const BRAIN_IDS = [
  "openrouter",
  "claude-agent-sdk",
  "openai-agents",
  "claude-code-cli",
  "codex-cli",
] as const

/** BRAIN-4: these drive a CLI on the machine, so they never run in production. */
export const CLI_BRAIN_IDS = ["claude-code-cli", "codex-cli"] as const

/** DM-1. Laya comes later. */
export const DECISION_MODEL_IDS = ["jev", "openai-decisions"] as const

/** DEP-2. */
export const TRANSCRIBER_IDS = ["sarvam", "openai"] as const
export const RETRIEVER_IDS = ["local", "pgvector"] as const
export const EMBEDDER_IDS = ["openai"] as const

export type BrainId = (typeof BRAIN_IDS)[number]
export type CliBrainId = (typeof CLI_BRAIN_IDS)[number]
export type DecisionModelId = (typeof DECISION_MODEL_IDS)[number]
export type TranscriberId = (typeof TRANSCRIBER_IDS)[number]
export type RetrieverId = (typeof RETRIEVER_IDS)[number]
export type EmbedderId = (typeof EMBEDDER_IDS)[number]

export function isCliBrain(id: string): id is CliBrainId {
  return (CLI_BRAIN_IDS as readonly string[]).includes(id)
}
