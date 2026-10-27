// BRAIN-1: OpenRouter, over its OpenAI compatible chat completions API
// with native tool calling.
//
// Checked against OpenRouter's docs on 2026-10-16:
// - tools are [{ type: "function", function: { name, description, parameters } }],
//   and a name may be at most 64 characters
// - a tool call comes back as choices[0].message.tool_calls[], each with an
//   id and function.arguments as a JSON *string*
// - finish_reason is normalised by OpenRouter to tool_calls, stop, length,
//   content_filter or error, with the provider's own value in
//   native_finish_reason
// - usage carries prompt_tokens, completion_tokens and cost, with no
//   parameter needed to ask for cost
import type { Brain, BrainInput, BrainMessage, BrainOutput } from "./types.ts"
import { BrainError } from "./types.ts"
import type { FetchLike } from "../http.ts"

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

/** Kept exported here because this adapter's tests import it from here. */
export type { FetchLike }

export interface OpenRouterOptions {
  apiKey: string
  baseUrl?: string | undefined
  /** Injected so contract tests run without network (TEST-3). */
  fetch?: FetchLike | undefined
  /** OpenRouter shows these on its activity page. */
  appUrl?: string | undefined
  appName?: string | undefined
}

/**
 * MEDIA-2: one part of a multipart user message.
 *
 * Checked against OpenRouter's own API reference on 2026-10-27, because a
 * mirror of the docs had a different shape. The image part is
 * `{ type: "image_url", image_url: { url } }`, and `url` takes a plain
 * https URL or a `data:` URL, both documented and both accepted.
 *
 * That the ref is passed through as the url rather than fetched is worth
 * knowing: the provider does the fetching, so the ref has to be something
 * the provider can reach. A channel whose media needs an auth header can
 * put a signed URL or a data URL in the ref, which is why the core does
 * not assume either (Known K25).
 */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

/** The wire shape of a chat message, as the API wants it. */
type WireMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "user"; content: ContentPart[] }
  | {
      role: "assistant"
      content: null
      tool_calls: { id: string; type: "function"; function: { name: string; arguments: string } }[]
    }
  | { role: "tool"; tool_call_id: string; content: string }

/**
 * LOOP-7's roles onto the four the API has.
 *
 * An operator's words and a notice are both things the person saw that the
 * agent did not write, so they are labelled rather than passed off as the
 * agent's own.
 */
export function toWireMessages(messages: BrainMessage[]): WireMessage[] {
  const wire: WireMessage[] = []

  for (const message of messages) {
    switch (message.role) {
      case "person": {
        // MEDIA-2: a plain string when there is nothing to look at, so the
        // common case stays the shape every provider handles best.
        if (message.images === undefined || message.images.length === 0) {
          wire.push({ role: "user", content: message.text })
          break
        }
        const parts: ContentPart[] = []
        if (message.text !== "") parts.push({ type: "text", text: message.text })
        for (const image of message.images) {
          parts.push({ type: "image_url", image_url: { url: image.ref } })
        }
        wire.push({ role: "user", content: parts })
        break
      }
      case "agent":
        wire.push({ role: "assistant", content: message.text })
        break
      case "operator":
        wire.push({ role: "assistant", content: `[from a human colleague] ${message.text}` })
        break
      case "notice":
        wire.push({ role: "system", content: `[shown to the person] ${message.text}` })
        break
      case "tool_call":
        wire.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: message.id,
              type: "function",
              function: { name: message.name, arguments: JSON.stringify(message.input ?? {}) },
            },
          ],
        })
        break
      case "tool_result":
        wire.push({
          role: "tool",
          tool_call_id: message.id,
          content: JSON.stringify(
            message.error !== undefined ? { error: message.error } : message.result,
          ),
        })
        break
    }
  }

  return wire
}

/** Arguments arrive as a JSON string, and a model can get that wrong. */
function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {}
  if (raw.trim() === "") return {}
  try {
    return JSON.parse(raw)
  } catch {
    // Left for the core to reject at LOOP-8 step 6, with the text kept so
    // the brain can be told what was wrong with it.
    return { __unparsed: raw }
  }
}

export function openRouterBrain(options: OpenRouterOptions): Brain {
  const call = options.fetch ?? globalThis.fetch
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")

  return {
    id: "openrouter",
    kind: "api",
    supportsImages: true,

    async complete(input: BrainInput): Promise<BrainOutput> {
      const body = {
        model: input.model,
        messages: [{ role: "system", content: input.system }, ...toWireMessages(input.messages)],
        ...(input.tools.length > 0
          ? {
              tools: input.tools.map((tool) => ({
                type: "function" as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
              tool_choice: "auto" as const,
            }
          : {}),
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      }
      if (options.appUrl !== undefined) headers["HTTP-Referer"] = options.appUrl
      if (options.appName !== undefined) headers["X-Title"] = options.appName

      let response: Response
      try {
        response = await call(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          ...(input.signal ? { signal: input.signal } : {}),
        })
      } catch (error) {
        // A network failure or an abort. Worth trying another brain.
        throw new BrainError("openrouter", `request failed: ${String(error)}`, true)
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        // 408, 429 and 5xx are worth another attempt; 4xx is our mistake.
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500
        throw new BrainError(
          "openrouter",
          `HTTP ${response.status} ${detail.slice(0, 300)}`,
          retryable,
        )
      }

      const payload = (await response.json()) as OpenRouterResponse
      return readResponse(payload)
    },
  }
}

interface OpenRouterResponse {
  choices?: {
    finish_reason?: string | null
    native_finish_reason?: string | null
    message?: {
      content?: string | null
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] | null
    } | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    cost?: number
  } | null
  error?: { message?: string } | null
}

/** Turns one response into the shape the core works in. */
export function readResponse(payload: OpenRouterResponse): BrainOutput {
  if (payload.error) {
    throw new BrainError("openrouter", payload.error.message ?? "unknown error", true)
  }

  const choice = payload.choices?.[0]
  if (choice === undefined) {
    throw new BrainError("openrouter", "the response held no choices", true)
  }

  const usage = {
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
    ...(typeof payload.usage?.cost === "number" ? { costUsd: payload.usage.cost } : {}),
  }

  const rawCalls = choice.message?.tool_calls ?? []
  const toolCalls = rawCalls
    .filter((entry) => typeof entry.function?.name === "string")
    .map((entry, index) => ({
      id: entry.id ?? `call_${index}`,
      name: entry.function?.name as string,
      input: parseArguments(entry.function?.arguments),
    }))

  const text = choice.message?.content ?? undefined

  return {
    ...(text !== undefined && text !== null && text !== "" ? { text } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    finishReason: choice.finish_reason ?? choice.native_finish_reason ?? "stop",
    usage,
  }
}
