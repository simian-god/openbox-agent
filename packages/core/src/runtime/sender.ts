// The Sender from Spec section 4. The channel glue implements it; the core
// only ever hands it an Outbound.

export interface SenderCapabilities {
  buttons: boolean
  files: boolean
  templates: boolean
  /** How long the channel allows a reply, as WhatsApp's 24 hours. */
  windowHours?: number | undefined
  /** The channel can safely receive the same send twice. */
  idempotentSends: boolean
}

export interface Outbound {
  channel: string
  channelUserId: string
  text?: string | undefined
  buttons?: { label: string; payload: string }[] | undefined
  template?: { name: string; vars: Record<string, string> } | undefined
  file?: { url: string; name: string; mime: string } | undefined
  /** The same key must never be sent twice (section 13). */
  idempotencyKey: string
}

export type SendResult =
  | { status: "sent"; channelMessageId: string }
  | { status: "rejected"; retryable: boolean; error: string }

export interface Sender {
  capabilities(channel: string): SenderCapabilities
  /** A thrown error stands for a timeout: the outcome is unknown. */
  send(out: Outbound): Promise<SendResult>
}

/** What the channel glue hands to `receive`. */
export interface Inbound {
  channel: string
  channelUserId: string
  /** Used to drop duplicates (LOOP-1). */
  channelMessageId: string
  receivedAt?: Date | undefined
  text?: string | undefined
  media?: { kind: "audio" | "image" | "file"; ref: string; mime: string; caption?: string }[]
  /** A button tap, passed through untouched. */
  action?: { payload: string } | undefined
  displayName?: string | undefined
  // API-3: there is deliberately no role here. Role comes only from the
  // database, so nothing in a message can grant itself one.
}
