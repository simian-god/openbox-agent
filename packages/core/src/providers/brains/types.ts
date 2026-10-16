// The Brain interface from Spec section 4. Everything that can answer a
// turn implements this, from a real model to the scripted fake the core's
// own tests run on.
import type { JSONSchema } from "../../tools/define.ts"

/**
 * One entry in the history LOOP-7 describes: the messages with this person,
 * then this turn's tool calls and their results.
 */
export type BrainMessage =
  | { role: "person"; text: string; images?: { ref: string; mime: string }[] }
  | { role: "agent"; text: string }
  | { role: "operator"; text: string }
  | { role: "notice"; text: string }
  | { role: "tool_call"; id: string; name: string; input: unknown }
  | { role: "tool_result"; id: string; name: string; result: unknown; error?: string }

/** A tool as the brain is told about it (TOOL-3 writes the description). */
export interface BrainTool {
  name: string
  description: string
  inputSchema: JSONSchema
}

export interface BrainInput {
  model: string
  /** The static prompt plus the runtime block (LOOP-7). */
  system: string
  messages: BrainMessage[]
  tools: BrainTool[]
  /** Abandon the call when this fires, so a step cannot hang (BRAIN-5). */
  signal?: AbortSignal | undefined
}

export interface BrainUsage {
  inputTokens: number
  outputTokens: number
  /** Only when the provider reports it. Otherwise the pricing table (LIMIT-3). */
  costUsd?: number | undefined
}

export interface BrainOutput {
  text?: string | undefined
  toolCalls?: { id: string; name: string; input: unknown }[] | undefined
  /** Normalised: stop, tool_calls, length, content_filter or error. */
  finishReason: string
  usage: BrainUsage
}

export interface Brain {
  id: string
  kind: "api" | "cli"
  supportsImages: boolean
  complete(input: BrainInput): Promise<BrainOutput>
}

/** Raised when a brain cannot answer. The step moves to the next (BRAIN-5). */
export class BrainError extends Error {
  readonly brainId: string
  /** True when trying the same brain again might work. */
  readonly retryable: boolean

  constructor(brainId: string, message: string, retryable = false) {
    super(`${brainId}: ${message}`)
    this.name = "BrainError"
    this.brainId = brainId
    this.retryable = retryable
  }
}
