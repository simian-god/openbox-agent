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

export {
  defineTool,
  createToolRegistry,
  brainDescription,
  ToolError,
  BUILTIN_TOOL_NAMES,
  isBuiltinToolName,
  RISK_LEVELS,
  ROLES,
  type Tool,
  type ToolDefinition,
  type ToolRegistry,
  type ToolContext,
  type ToolConditions,
  type ToolExamples,
  type BuiltinToolName,
  type JSONSchema,
  type Risk,
  type Role,
} from "./tools/index.ts"

export {
  migrate,
  collectMigrations,
  readMigrations,
  tablesWithoutRls,
  MigrateError,
  CORE_MIGRATIONS_DIR,
  type Migration,
  type MigrateOptions,
  type MigrateResult,
} from "./migrate/index.ts"
