// Discord glue: an interactions endpoint in, a Sender out.
//
// What Discord's docs say, read on 2026-10-30, and what this does:
//
// - A button's `custom_id` is up to 100 characters, which the core's
//   payload fits with room to spare. An action row holds 5 buttons, and a
//   message holds 5 rows.
// - An interaction must be answered within 3 seconds. A turn takes
//   longer than that, so a tap is acknowledged at once with a deferred
//   update and the reply arrives as an ordinary message afterwards.
// - The endpoint is verified with Ed25519 over the timestamp followed by
//   the raw body, using the application's public key, with
//   `X-Signature-Ed25519` and `X-Signature-Timestamp`. An invalid
//   signature gets a 401. Discord sends a bad signature on purpose when
//   the endpoint is first set, and refuses the URL if it gets a 200.
// - A PING (type 1) must be answered with a PONG (type 1).
//
// One Discord oddity worth knowing: a bot can only open a DM with
// somebody who shares a server with it, and the DM channel has to be
// created before the first message. That is what `dmChannelFor` is for.
import { verify } from "node:crypto"
import type {
  Agent,
  Inbound,
  Outbound,
  SendResult,
  Sender,
  SenderCapabilities,
} from "openbox-agent"

const CHANNEL = "discord"

const API = "https://discord.com/api/v10"
const token = process.env["DISCORD_BOT_TOKEN"] ?? ""
const publicKey = process.env["DISCORD_PUBLIC_KEY"] ?? ""

/** Discord's limits: 100 characters of hidden data, 5 buttons a row. */
const CUSTOM_ID = 100
const BUTTONS_PER_ROW = 5

const dmChannels = new Map<string, string>()

/** The DM channel for one user, opened once and remembered. */
async function dmChannelFor(userId: string): Promise<string> {
  const known = dmChannels.get(userId)
  if (known !== undefined) return known

  const response = await fetch(`${API}/users/@me/channels`, {
    method: "POST",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ recipient_id: userId }),
  })
  const opened = (await response.json().catch(() => ({}))) as { id?: string }
  if (opened.id === undefined) throw new Error(`discord would not open a DM with ${userId}`)
  dmChannels.set(userId, opened.id)
  return opened.id
}

const sender: Sender = {
  capabilities(): SenderCapabilities {
    return {
      buttons: true,
      files: true,
      templates: false,
      idempotentSends: false,
    }
  },

  async send(out: Outbound): Promise<SendResult> {
    if (out.text === undefined && out.file === undefined) {
      return { status: "rejected", retryable: false, error: "nothing to send" }
    }

    let channelId: string
    try {
      channelId = await dmChannelFor(out.channelUserId)
    } catch (error) {
      // Worth retrying: this is usually Discord rather than the message.
      return {
        status: "rejected",
        retryable: true,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const components =
      out.buttons === undefined || out.buttons.length === 0
        ? []
        : [
            {
              type: 1, // action row
              components: out.buttons.slice(0, BUTTONS_PER_ROW).map((button) => ({
                type: 2, // button
                // 1 is the blue one. The core only ever sends Confirm and
                // Cancel, so Cancel gets the grey one.
                style: button.label.toLowerCase() === "cancel" ? 2 : 1,
                label: button.label,
                // The core's payload, untouched (CONF-7).
                custom_id: button.payload.slice(0, CUSTOM_ID),
              })),
            },
          ]

    const response = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        content: out.text ?? "",
        ...(components.length > 0 ? { components } : {}),
        ...(out.file !== undefined ? { embeds: [{ url: out.file.url }] } : {}),
      }),
    })

    const said = (await response.json().catch(() => ({}))) as { id?: string; message?: string }
    if (response.ok && said.id !== undefined) {
      return { status: "sent", channelMessageId: said.id }
    }

    return {
      status: "rejected",
      retryable: response.status === 429 || response.status >= 500,
      error: `${response.status} ${said.message ?? "no message id returned"}`,
    }
  },
}

/** One interaction or message as an Inbound, or null. */
export function inboundFrom(body: Record<string, any>): Inbound | null {
  // A button tap. Type 3 is a message component.
  if (body["type"] === 3) {
    const user = body["user"] ?? body["member"]?.["user"] ?? {}
    return {
      channel: CHANNEL,
      channelUserId: String(user["id"] ?? ""),
      // The interaction id, unique per tap.
      channelMessageId: String(body["id"] ?? ""),
      action: { payload: String(body["data"]?.["custom_id"] ?? "") },
      ...(typeof user["username"] === "string" ? { displayName: user["username"] } : {}),
    }
  }

  // {{discord_messages}}: a DM to the bot arrives over the gateway rather
  // than the interactions endpoint, so a Discord agent that answers plain
  // messages needs a gateway connection as well. If the agent only ever
  // answers buttons and slash commands, this endpoint is all it needs.
  //
  // Type 2 is a slash command, which arrives here and carries its own
  // options.
  if (body["type"] === 2) {
    const user = body["user"] ?? body["member"]?.["user"] ?? {}
    const said = (body["data"]?.["options"] ?? []).find((option: any) => option["name"] === "text")
    return {
      channel: CHANNEL,
      channelUserId: String(user["id"] ?? ""),
      channelMessageId: String(body["id"] ?? ""),
      text: String(said?.["value"] ?? ""),
      ...(typeof user["username"] === "string" ? { displayName: user["username"] } : {}),
    }
  }

  return null
}

/** Ed25519 over the timestamp and the raw body, with the public key. */
function signatureIsValid(
  raw: string,
  signature: string | null,
  timestamp: string | null,
): boolean {
  if (signature === null || timestamp === null || publicKey === "") return false
  try {
    return verify(
      null,
      Buffer.from(timestamp + raw),
      {
        key: Buffer.concat([
          // An Ed25519 public key as DER, which is a fixed 12 byte
          // prefix and then the 32 key bytes.
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(publicKey, "hex"),
        ]),
        format: "der",
        type: "spki",
      },
      Buffer.from(signature, "hex"),
    )
  } catch {
    return false
  }
}

async function serve(agent: Agent): Promise<void> {
  const port = Number(process.env["PORT"] ?? 8080)

  Bun.serve({
    port,
    async fetch(request) {
      if (request.method !== "POST") return new Response("no", { status: 405 })

      const raw = await request.text()
      const valid = signatureIsValid(
        raw,
        request.headers.get("X-Signature-Ed25519"),
        request.headers.get("X-Signature-Timestamp"),
      )
      // 401, not 200. Discord checks this by sending a deliberately bad
      // signature and will not accept an endpoint that answers it.
      if (!valid) return new Response("bad signature", { status: 401 })

      const body = JSON.parse(raw) as Record<string, any>

      // A PING has to come back as a PONG.
      if (body["type"] === 1) {
        return Response.json({ type: 1 })
      }

      const inbound = inboundFrom(body)
      if (inbound !== null) void agent.receive(inbound)

      // Type 6 is "acknowledge and leave the message as it is". The three
      // second clock is answered here and the real reply arrives as an
      // ordinary message when the turn finishes.
      return Response.json({ type: body["type"] === 3 ? 6 : 5 })
    },
  })

  console.log(`discord interactions endpoint listening on ${port}`)
  await new Promise<void>(() => {})
}

export default { sender, serve }
