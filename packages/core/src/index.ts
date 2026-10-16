// openbox-agent: the only public entry point. Agents import nothing else
// from this package (PKG-1, PKG-2).

export {
  defineConfig,
  ConfigError,
  configSchema,
  type OpenboxConfig,
  type OpenboxConfigInput,
  BRAIN_IDS,
  CLI_BRAIN_IDS,
  DECISION_MODEL_IDS,
  TRANSCRIBER_IDS,
  RETRIEVER_IDS,
  EMBEDDER_IDS,
  isCliBrain,
  type BrainId,
  type CliBrainId,
  type DecisionModelId,
  type TranscriberId,
  type RetrieverId,
  type EmbedderId,
} from "./config/index.ts"
