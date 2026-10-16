// A Sender that records instead of sending, for the core's own tests and
// for an agent builder's.
import type { Outbound, Sender, SenderCapabilities, SendResult } from "../runtime/sender.ts"

export interface FakeSenderOptions {
  capabilities?: Partial<SenderCapabilities>
  /**
   * Decides what happens to a send. Returning undefined means it is sent.
   * Throwing stands for a timeout, where the outcome is unknown.
   */
  respond?: (out: Outbound) => SendResult | undefined
}

export interface FakeSender extends Sender {
  /** Every send, in order. */
  readonly sent: Outbound[]
  /** The text of every send, which is what most tests want to read. */
  texts(): string[]
  reset(): void
}

export function fakeSender(options: FakeSenderOptions = {}): FakeSender {
  const sent: Outbound[] = []
  let counter = 0

  return {
    sent,

    capabilities(): SenderCapabilities {
      return {
        buttons: true,
        files: true,
        templates: false,
        idempotentSends: true,
        ...options.capabilities,
      }
    },

    async send(out: Outbound): Promise<SendResult> {
      sent.push(out)
      const decided = options.respond?.(out)
      if (decided !== undefined) return decided

      counter++
      return { status: "sent", channelMessageId: `fake-${counter}` }
    },

    texts: () => sent.map((out) => out.text ?? ""),

    reset() {
      sent.length = 0
      counter = 0
    },
  }
}
