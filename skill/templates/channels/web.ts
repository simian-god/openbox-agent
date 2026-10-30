// A generic web webhook: for a chat widget on the builder's own site, or
// any system that can POST a message and accept one back.
//
// This is the one channel with no vendor behind it, so the shape is ours.
// Two endpoints:
//
//   POST /inbound   { userId, messageId, text? , payload?, name? }
//   POST <reply_url> { to, text?, buttons?, file? }   (what this sends)
//
// Both carry a shared secret in `X-Openbox-Signature`, as an HMAC-SHA256
// of the raw body. A bearer token would do as well; what matters is that
// anybody who can reach the endpoint cannot write as somebody else, since
// `userId` is who the agent thinks it is talking to.
import { createHmac, timingSafeEqual } from "node:crypto"
import type {
  Agent,
  Inbound,
  Outbound,
  SendResult,
  Sender,
  SenderCapabilities,
} from "openbox-agent"

const CHANNEL = "web"

const secret = process.env["WEB_WEBHOOK_SECRET"] ?? ""
// {{reply_url}}: where this agent POSTs its replies. The builder's own
// front end, or whatever holds the browser connection open.
const replyUrl = process.env["WEB_REPLY_URL"] ?? ""

const sender: Sender = {
  capabilities(): SenderCapabilities {
    return {
      // {{web_buttons}}: true only once the front end really renders
      // `buttons` as something tappable. Left false, the core sends the
      // four digit code instead, which works in any chat window
      // (CONF-1). Saying true and showing nothing would leave a person
      // with a confirmation they cannot answer.
      buttons: false,
      files: true,
      templates: false,
      // No window: a web page can be written to whenever it is open.
      //
      // Honest rather than hopeful again. Set this to true only if the
      // receiving endpoint really drops a repeated `idempotencyKey`,
      // which is what lets SEND-1 retry a send whose outcome is unknown.
      idempotentSends: false,
    }
  },

  async send(out: Outbound): Promise<SendResult> {
    if (replyUrl === "") {
      return { status: "rejected", retryable: false, error: "WEB_REPLY_URL is not set" }
    }

    const body = JSON.stringify({
      to: out.channelUserId,
      ...(out.text !== undefined ? { text: out.text } : {}),
      // The core's payloads, passed straight through (CONF-7).
      ...(out.buttons !== undefined ? { buttons: out.buttons } : {}),
      ...(out.file !== undefined ? { file: out.file } : {}),
      // So the far end can drop a repeat of a send it already took.
      idempotencyKey: out.idempotencyKey,
    })

    const response = await fetch(replyUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Openbox-Signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    })

    if (response.ok) {
      const said = (await response.json().catch(() => ({}))) as { id?: string }
      return { status: "sent", channelMessageId: said.id ?? out.idempotencyKey }
    }

    return {
      status: "rejected",
      retryable: response.status === 429 || response.status >= 500,
      error: `${response.status} from the reply endpoint`,
    }
  },
}

/** One posted message as an Inbound, or null if it is not one. */
export function inboundFrom(body: Record<string, any>): Inbound | null {
  const userId = typeof body["userId"] === "string" ? body["userId"] : ""
  const messageId = typeof body["messageId"] === "string" ? body["messageId"] : ""
  // Both are required. Without a message id, LOOP-1 cannot tell a retry
  // from a new message and the same thing would be answered twice.
  if (userId === "" || messageId === "") return null

  return {
    channel: CHANNEL,
    channelUserId: userId,
    channelMessageId: messageId,
    ...(typeof body["text"] === "string" ? { text: body["text"] } : {}),
    ...(typeof body["payload"] === "string" && body["payload"] !== ""
      ? { action: { payload: body["payload"] } }
      : {}),
    ...(typeof body["name"] === "string" ? { displayName: body["name"] } : {}),
  }
}

function signatureIsValid(raw: string, header: string | null): boolean {
  if (header === null || secret === "") return false
  const want = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
  const given = Buffer.from(header)
  const expected = Buffer.from(want)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function serve(agent: Agent): Promise<void> {
  const port = Number(process.env["PORT"] ?? 8080)

  Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url)

      // {{health_path}}: most hosts want one.
      if (request.method === "GET" && url.pathname === "/health") {
        return new Response("ok", { status: 200 })
      }

      if (request.method !== "POST" || url.pathname !== "/inbound") {
        return new Response("no", { status: 404 })
      }

      const raw = await request.text()
      if (!signatureIsValid(raw, request.headers.get("X-Openbox-Signature"))) {
        return new Response("bad signature", { status: 401 })
      }

      const inbound = inboundFrom(JSON.parse(raw) as Record<string, any>)
      if (inbound === null) {
        return Response.json({ error: "userId and messageId are both required" }, { status: 400 })
      }

      // Written down and answered by the worker, so this returns in
      // milliseconds whatever the turn goes on to cost.
      const { inboxId, duplicate } = await agent.receive(inbound)
      return Response.json({ inboxId, duplicate }, { status: 200 })
    },
  })

  console.log(`web webhook listening on ${port}`)
  await new Promise<void>(() => {})
}

export default { sender, serve }
