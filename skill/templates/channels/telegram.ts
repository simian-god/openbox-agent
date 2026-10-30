// Telegram Bot API glue: a webhook in, a Sender out.
//
// Checked against Telegram's own reference on 2026-10-30:
//
// - An inline button's `callback_data` is "1-64 bytes". That is the
//   tightest button payload of any channel here, and it is why CONF-3's
//   payload writes the action id in short form: 61 bytes, so it fits.
//   Nothing in this file shortens anything, and nothing in this file may:
//   the payload is the core's (CONF-7).
// - A tap arrives as `callback_query`, with `data` carrying the payload.
//   The client shows a spinner until `answerCallbackQuery` is called, so
//   that happens first, before the turn is even started.
// - `sendMessage` takes text of 1 to 4096 characters, and `reply_markup`
//   as a JSON-serialised object.
// - `setWebhook` takes a `secret_token` of 1 to 256 characters from
//   [A-Za-z0-9_-], and every webhook request then carries it in the
//   `X-Telegram-Bot-Api-Secret-Token` header. That is the only thing that
//   tells a real update from anybody who found the URL.
//
// This is also the channel an operator team usually sits on, which needs
// nothing in this file: `openbox operator add telegram <numeric id>` is
// what makes somebody an operator (ROLE-2), and the same glue then
// carries both sides.
import type {
  Agent,
  Inbound,
  Outbound,
  SendResult,
  Sender,
  SenderCapabilities,
} from "openbox-agent"

const CHANNEL = "telegram"

const token = process.env["TELEGRAM_BOT_TOKEN"] ?? ""
const webhookSecret = process.env["TELEGRAM_WEBHOOK_SECRET"] ?? ""

const API = `https://api.telegram.org/bot${token}`

/** Telegram's own limit on one message. */
const TEXT_LIMIT = 4096

/** And on a button's hidden data. The payload is built to fit this. */
const CALLBACK_DATA_BYTES = 64

const sender: Sender = {
  capabilities(): SenderCapabilities {
    return {
      buttons: true,
      files: true,
      // No approved template system, and no reply window either: a bot
      // may write to anybody who has ever started it.
      templates: false,
      idempotentSends: false,
    }
  },

  async send(out: Outbound): Promise<SendResult> {
    if (out.file !== undefined) return call("sendDocument", { document: out.file.url }, out)
    if (out.text === undefined || out.text === "") {
      return { status: "rejected", retryable: false, error: "nothing to send" }
    }

    const markup =
      out.buttons === undefined || out.buttons.length === 0
        ? {}
        : {
            reply_markup: JSON.stringify({
              // One button per row, so a long label is not cut off.
              // `callback_data` is the core's payload, unchanged.
              inline_keyboard: out.buttons.map((button) => [
                { text: button.label, callback_data: button.payload },
              ]),
            }),
          }

    // A payload too long for Telegram is refused here rather than sent
    // and rejected by the API, so the error says what is actually wrong.
    for (const button of out.buttons ?? []) {
      if (Buffer.byteLength(button.payload, "utf8") > CALLBACK_DATA_BYTES) {
        return {
          status: "rejected",
          retryable: false,
          error: `a button payload is ${Buffer.byteLength(button.payload, "utf8")} bytes and Telegram allows ${CALLBACK_DATA_BYTES}`,
        }
      }
    }

    return call("sendMessage", { text: out.text.slice(0, TEXT_LIMIT), ...markup }, out)
  },
}

async function call(
  method: string,
  fields: Record<string, unknown>,
  out: Outbound,
): Promise<SendResult> {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: out.channelUserId, ...fields }),
  })

  const said = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    result?: { message_id?: number }
    description?: string
    parameters?: { retry_after?: number }
  }

  if (response.ok && said.ok === true && said.result?.message_id !== undefined) {
    return { status: "sent", channelMessageId: String(said.result.message_id) }
  }

  // 429 carries `retry_after`, and a 5xx is Telegram's side. Everything
  // else is this message being wrong.
  return {
    status: "rejected",
    retryable: response.status === 429 || response.status >= 500,
    error: `${response.status} ${said.description ?? "no message id returned"}`,
  }
}

/** One update as an Inbound, or null for anything that is not a message. */
export function inboundFrom(update: Record<string, any>): Inbound | null {
  const tap = update["callback_query"]
  if (tap !== undefined) {
    const from = tap["from"] ?? {}
    return {
      channel: CHANNEL,
      // The person's own id, not the chat's: a group chat has one chat id
      // and several people in it.
      channelUserId: String(from["id"] ?? ""),
      // The query id, which is unique per tap, so a retried webhook is
      // dropped by LOOP-1 rather than confirming twice.
      channelMessageId: `cb:${String(tap["id"] ?? "")}`,
      action: { payload: String(tap["data"] ?? "") },
      ...nameOf(from),
    }
  }

  const message = update["message"] ?? update["edited_message"]
  if (message === undefined) return null
  const from = message["from"] ?? {}
  const common = {
    channel: CHANNEL,
    channelUserId: String(from["id"] ?? ""),
    channelMessageId: String(message["message_id"] ?? ""),
    ...(typeof message["date"] === "number"
      ? { receivedAt: new Date(message["date"] * 1000) }
      : {}),
    ...nameOf(from),
  }

  if (typeof message["text"] === "string") return { ...common, text: message["text"] }

  // A voice note, which MEDIA-1 transcribes. `getFile` turns a file_id
  // into a path to download, with the bot token on the URL.
  const voice = message["voice"] ?? message["audio"]
  if (voice !== undefined) {
    return {
      ...common,
      media: [
        {
          kind: "audio",
          ref: String(voice["file_id"] ?? ""),
          mime: String(voice["mime_type"] ?? "audio/ogg"),
        },
      ],
    }
  }

  const photo = message["photo"]
  if (Array.isArray(photo) && photo.length > 0) {
    // The last one is the largest.
    const largest = photo[photo.length - 1]
    return {
      ...common,
      media: [{ kind: "image", ref: String(largest["file_id"] ?? ""), mime: "image/jpeg" }],
      ...(typeof message["caption"] === "string" ? { text: message["caption"] } : {}),
    }
  }

  return null
}

function nameOf(from: Record<string, any>): { displayName?: string } {
  const name = [from["first_name"], from["last_name"]].filter((part) => typeof part === "string")
  return name.length > 0 ? { displayName: name.join(" ") } : {}
}

/** Stops the spinner on the tapped button. Telegram asks for this. */
async function acknowledge(callbackQueryId: string): Promise<void> {
  await fetch(`${API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  }).catch(() => {
    // A failed acknowledgement leaves a spinner, which is a cosmetic
    // problem. Losing the tap would not be, so it is never thrown.
  })
}

async function serve(agent: Agent): Promise<void> {
  const port = Number(process.env["PORT"] ?? 8080)

  Bun.serve({
    port,
    async fetch(request) {
      if (request.method !== "POST") return new Response("no", { status: 405 })

      // The only thing that tells a real update from somebody who found
      // the URL. Set it with setWebhook's `secret_token`.
      const given = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
      if (webhookSecret === "" || given !== webhookSecret) {
        return new Response("bad secret", { status: 401 })
      }

      const update = (await request.json().catch(() => ({}))) as Record<string, any>

      // Before anything else, so the person's button stops spinning
      // whatever the turn goes on to do.
      const tapId = update["callback_query"]?.["id"]
      if (typeof tapId === "string") await acknowledge(tapId)

      const inbound = inboundFrom(update)
      if (inbound !== null) void agent.receive(inbound)

      // 200 either way. Telegram retries anything else and keeps the
      // update at the head of the queue, which stops every later one.
      return new Response("ok", { status: 200 })
    },
  })

  console.log(`telegram webhook listening on ${port}`)
  await new Promise<void>(() => {})
}

export default { sender, serve }
