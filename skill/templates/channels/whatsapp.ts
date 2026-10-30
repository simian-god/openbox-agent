// WhatsApp Cloud API glue: a webhook in, a Sender out.
//
// Checked against Meta's own docs on 2026-10-30. What they say, and what
// this file does about each of it:
//
// - Quick reply buttons: up to 10, button text 20 characters, body 1024,
//   header and footer 60. The core sends two buttons (Confirm, Cancel),
//   so the only limit that bites is the 20 characters, and a longer label
//   is cut rather than letting the send fail.
// - The customer service window is 24 hours from the person's last
//   message. Inside it anything may be sent. Outside it only an approved
//   template goes out, and a free-form send fails (error 131047). That is
//   why `capabilities` says `windowHours: 24`: PRO-3 reads it and will
//   not even try a free-form proactive message outside the window.
// - A button tap arrives in two different shapes. A free-form interactive
//   button comes back as `type: "interactive"` with
//   `interactive.button_reply.{id,title}`, and the same button on a
//   template comes back as `type: "button"` with `button.{payload,text}`.
//   Both are read below: a glue that read only the first would silently
//   drop every confirm that went out as a template.
// - Messages are paced. A dropped message shows up only in a status
//   webhook with `status: "failed"` and error 135000, never in the send's
//   own response.
//
// Verification: every POST carries `X-Hub-Signature-256`, an HMAC-SHA256
// of the raw body keyed with the app secret. It is checked here before
// the body is parsed, because parsing and re-serialising changes the
// bytes the signature was made over.
import { createHmac, timingSafeEqual } from "node:crypto"
import type {
  Agent,
  Inbound,
  Outbound,
  SendResult,
  Sender,
  SenderCapabilities,
} from "openbox-agent"

const CHANNEL = "whatsapp"

// {{graph_version}}: pin it. Meta ships breaking changes between versions
// and an unpinned URL moves under the agent.
const GRAPH = "https://graph.facebook.com/v23.0"

const token = process.env["WHATSAPP_TOKEN"] ?? ""
const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"] ?? ""
const appSecret = process.env["WHATSAPP_APP_SECRET"] ?? ""
const verifyToken = process.env["WHATSAPP_VERIFY_TOKEN"] ?? ""

/** Meta's limit on a quick reply's text. */
const BUTTON_TEXT = 20

const sender: Sender = {
  capabilities(): SenderCapabilities {
    return {
      buttons: true,
      files: true,
      templates: true,
      // The customer service window, which PRO-3 depends on.
      windowHours: 24,
      // Honest rather than hopeful: the Cloud API has no idempotency key,
      // so a retried send can arrive twice. SEND-1 then leaves a timed
      // out send alone instead of resending it.
      idempotentSends: false,
    }
  },

  async send(out: Outbound): Promise<SendResult> {
    const body = messageFor(out)
    if (body === null) {
      return { status: "rejected", retryable: false, error: "nothing to send" }
    }

    const response = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: out.channelUserId, ...body }),
    })

    const said = (await response.json().catch(() => ({}))) as {
      messages?: { id: string }[]
      error?: { message?: string; code?: number }
    }

    if (response.ok && said.messages?.[0] !== undefined) {
      return { status: "sent", channelMessageId: said.messages[0].id }
    }

    // A 4xx is the message being wrong and will be wrong next time. A 5xx
    // or a 429 is Meta having a moment, so the outbox may try again
    // (SEND-2 and SEND-3).
    return {
      status: "rejected",
      retryable: response.status >= 500 || response.status === 429,
      error: `${response.status} ${said.error?.message ?? "no message id returned"}`,
    }
  },
}

/** An Outbound as a Cloud API message body. */
function messageFor(out: Outbound): Record<string, unknown> | null {
  if (out.template !== undefined) {
    return {
      type: "template",
      template: {
        name: out.template.name,
        // {{template_language}}: the language the template was approved
        // in. A template is approved per language and this has to match.
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: Object.values(out.template.vars).map((text) => ({ type: "text", text })),
          },
        ],
      },
    }
  }

  if (out.file !== undefined) {
    return {
      type: "document",
      document: { link: out.file.url, filename: out.file.name },
    }
  }

  if (out.buttons !== undefined && out.buttons.length > 0) {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: out.text ?? "" },
        action: {
          buttons: out.buttons.map((button) => ({
            type: "reply",
            // The payload is the core's and goes through untouched
            // (CONF-7). The label is ours to cut: 20 characters is Meta's
            // limit, and "Confirm" and "Cancel" are well inside it.
            reply: { id: button.payload, title: button.label.slice(0, BUTTON_TEXT) },
          })),
        },
      },
    }
  }

  if (out.text === undefined || out.text === "") return null
  return { type: "text", text: { body: out.text, preview_url: false } }
}

/** One webhook message as an Inbound, or null for anything else. */
export function inboundFrom(
  message: Record<string, any>,
  contact?: Record<string, any>,
): Inbound | null {
  const from = typeof message["from"] === "string" ? message["from"] : ""
  const id = typeof message["id"] === "string" ? message["id"] : ""
  if (from === "" || id === "") return null

  const common = {
    channel: CHANNEL,
    channelUserId: from,
    channelMessageId: id,
    ...(typeof message["timestamp"] === "string"
      ? { receivedAt: new Date(Number(message["timestamp"]) * 1000) }
      : {}),
    ...(typeof contact?.["profile"]?.["name"] === "string"
      ? { displayName: contact["profile"]["name"] as string }
      : {}),
  }

  switch (message["type"]) {
    case "text":
      return { ...common, text: message["text"]?.["body"] ?? "" }

    // A tap on a free-form interactive button.
    case "interactive": {
      const reply = message["interactive"]?.["button_reply"]
      if (reply === undefined) return null
      return { ...common, action: { payload: String(reply["id"] ?? "") } }
    }

    // The same tap, when the buttons went out on a template. A different
    // shape for the same thing, which is Meta's and not ours.
    case "button":
      return { ...common, action: { payload: String(message["button"]?.["payload"] ?? "") } }

    case "audio":
    case "image":
    case "document": {
      const kind = message["type"] === "document" ? "file" : message["type"]
      const media = message[message["type"] as string] ?? {}
      return {
        ...common,
        media: [
          {
            kind: kind as "audio" | "image" | "file",
            // The media id. MEDIA-1's transcriber is handed this, and the
            // download needs the same token as a send.
            ref: String(media["id"] ?? ""),
            mime: String(media["mime_type"] ?? "application/octet-stream"),
            ...(typeof media["caption"] === "string" ? { caption: media["caption"] } : {}),
          },
        ],
      }
    }

    // A status update, a reaction, an unsupported type. Not a message.
    default:
      return null
  }
}

/** Meta's signature over the raw body. Checked before anything is parsed. */
function signatureIsValid(raw: string, header: string | null): boolean {
  if (header === null || !header.startsWith("sha256=")) return false
  const want = createHmac("sha256", appSecret).update(raw).digest("hex")
  const given = Buffer.from(header.slice("sha256=".length))
  const expected = Buffer.from(want)
  // Same length first: timingSafeEqual throws on a mismatch, and the
  // length is not a secret.
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function serve(agent: Agent): Promise<void> {
  // {{port}}: whatever the host gives this process.
  const port = Number(process.env["PORT"] ?? 8080)

  Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url)

      // Meta's one time handshake when the webhook is first set.
      if (request.method === "GET") {
        const mode = url.searchParams.get("hub.mode")
        const given = url.searchParams.get("hub.verify_token")
        const challenge = url.searchParams.get("hub.challenge") ?? ""
        if (mode === "subscribe" && given === verifyToken && verifyToken !== "") {
          return new Response(challenge, { status: 200 })
        }
        return new Response("no", { status: 403 })
      }

      if (request.method !== "POST") return new Response("no", { status: 405 })

      const raw = await request.text()
      if (!signatureIsValid(raw, request.headers.get("X-Hub-Signature-256"))) {
        return new Response("bad signature", { status: 401 })
      }

      // 200 first, work after. Meta retries anything that is not a 200,
      // and a retry of a message already taken is dropped by LOOP-1
      // anyway, so there is nothing to gain by making it wait.
      const body = JSON.parse(raw) as Record<string, any>
      for (const entry of body["entry"] ?? []) {
        for (const change of entry["changes"] ?? []) {
          const value = change["value"] ?? {}
          const contact = value["contacts"]?.[0]
          for (const message of value["messages"] ?? []) {
            const inbound = inboundFrom(message, contact)
            // LOOP-1: `receive` writes it down and returns. The worker
            // answers it, in this process or another one.
            if (inbound !== null) void agent.receive(inbound)
          }
        }
      }
      return new Response("ok", { status: 200 })
    },
  })

  console.log(`whatsapp webhook listening on ${port}`)
  // Never resolves: this is the line main.ts sits on.
  await new Promise<void>(() => {})
}

export default { sender, serve }
