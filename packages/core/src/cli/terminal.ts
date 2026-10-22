// SKILL-6: the terminal channel, and the chat loop that drives it.
//
// This is channel glue, the same job the WhatsApp or Telegram glue does in
// a real agent: it turns typed lines into `Inbound` and prints whatever
// the core hands its `Sender`. It ships with the core because `openbox
// chat` needs one, and because a builder's first conversation with their
// agent should not wait on them writing any glue at all.
//
// Reading and writing go through an injected `ChatIo`, so the parts with a
// decision in them can be tested without a terminal.
import type { Agent } from "../runtime/agent.ts"
import type { Outbound, Sender, SenderCapabilities } from "../runtime/sender.ts"

export const TERMINAL_CHANNEL = "terminal"

/** The person chatting locally, when nothing else is said. */
export const LOCAL_USER = "local"

/** Where typed lines come from and where output goes. */
export interface ChatIo {
  lines(): AsyncIterable<string>
  write(text: string): void
}

export interface ChatButton {
  label: string
  payload: string
}

/** What a typed line turned out to mean. */
export type ChatInput =
  /** One of chat's own commands, like `:quit`. */
  | { kind: "command"; name: string }
  /** A button the agent offered, tapped by number or by label. */
  | { kind: "tap"; label: string; payload: string }
  | { kind: "text"; text: string }
  /** Nothing was typed, so nothing is sent. */
  | { kind: "blank" }

/** `:q` is the only short form worth having. */
const COMMAND_ALIASES: Record<string, string> = { q: "quit" }

/**
 * What a typed line means, given the buttons currently on offer.
 *
 * Chat's own commands start with a colon, not a slash, so that an
 * operator's `/` commands (section 11) can be typed straight through to
 * the agent instead of being swallowed here.
 */
export function readLine(line: string, buttons: readonly ChatButton[]): ChatInput {
  const trimmed = line.trim()
  if (trimmed === "") return { kind: "blank" }

  if (trimmed.startsWith(":")) {
    const name = trimmed.slice(1).toLowerCase()
    return { kind: "command", name: COMMAND_ALIASES[name] ?? name }
  }

  if (buttons.length > 0) {
    const asNumber = Number(trimmed)
    const picked =
      Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= buttons.length
        ? buttons[asNumber - 1]
        : buttons.find((button) => button.label.toLowerCase() === trimmed.toLowerCase())

    if (picked !== undefined) return { kind: "tap", label: picked.label, payload: picked.payload }
  }

  return { kind: "text", text: trimmed }
}

/** One outbound message, as a terminal can show it. */
export function formatOutbound(
  out: Pick<Outbound, "text" | "buttons" | "file" | "template">,
): string {
  const lines: string[] = []
  if (out.text !== undefined && out.text !== "") lines.push(out.text)

  for (const [index, button] of (out.buttons ?? []).entries()) {
    lines.push(`  [${index + 1}] ${button.label}`)
  }

  // Capabilities say a terminal can show neither of these, so the core
  // should never send one. Naming it beats dropping it in silence.
  if (out.file !== undefined) {
    lines.push(`  [file] ${out.file.name} (${out.file.mime}) ${out.file.url}`)
  }
  if (out.template !== undefined) {
    lines.push(`  [template] ${out.template.name} ${JSON.stringify(out.template.vars)}`)
  }

  if (lines.length === 0) return "(a message with nothing in it)"
  return lines.join("\n")
}

export interface TerminalChannelOptions {
  io: ChatIo
  /** Who is typing. Keeping it the same keeps the conversation history. */
  channelUserId?: string | undefined
  displayName?: string | undefined
  /** Makes channel message ids unique to this session. */
  sessionId?: string | undefined
  /** What to print as the agent's name. Defaults to the agent's own name. */
  speaker?: string | undefined
}

export interface TerminalChannel {
  readonly sender: Sender
  /** The buttons the last message offered, which a number can tap. */
  buttons(): readonly ChatButton[]
  /** Talks until the person types `:quit`, or the input ends. */
  run(agent: Agent): Promise<void>
}

const CAPABILITIES: SenderCapabilities = {
  // Printed and typed back by number, so the confirm flow works here.
  buttons: true,
  // A terminal cannot deliver either of these.
  files: false,
  templates: false,
  // Printing twice shows it twice, so a repeat send is not harmless.
  idempotentSends: false,
}

const HELP = `Commands:
  :help      this list
  :version   the version this agent is running
  :trace     what the last turn recorded
  :quit      leave

Anything else is a message to the agent. A line starting with / is sent as
a message too, so an operator's commands can be typed.`

export function terminalChannel(options: TerminalChannelOptions): TerminalChannel {
  const { io } = options
  const channelUserId = options.channelUserId ?? LOCAL_USER
  // Random rather than a timestamp. TIME-1 keeps the system clock out of
  // the core, and two sessions started in the same millisecond would have
  // shared an id anyway, which is the one thing a session id must not do.
  const sessionId = options.sessionId ?? Math.random().toString(36).slice(2, 10)

  let buttons: readonly ChatButton[] = []
  let sent = 0
  let speaker = options.speaker ?? "agent"

  const sender: Sender = {
    capabilities: () => CAPABILITIES,

    async send(out: Outbound) {
      // Only what was offered last can be tapped, so a stale number
      // cannot pick something the person can no longer see.
      buttons = out.buttons ?? []
      io.write(`${speaker}> ${formatOutbound(out)}\n`)
      sent++
      return { status: "sent" as const, channelMessageId: `${sessionId}-out-${sent}` }
    },
  }

  return {
    sender,
    buttons: () => buttons,

    async run(agent: Agent): Promise<void> {
      speaker = options.speaker ?? agent.config.name
      let received = 0

      const tools = agent.tools.all().length
      io.write(`openbox chat - ${agent.config.name}\n`)
      io.write(`${tools} tool${tools === 1 ? "" : "s"} loaded.\n`)
      io.write("Type a message and press enter. :help for commands, :quit to leave.\n\n")

      for await (const line of io.lines()) {
        const input = readLine(line, buttons)

        if (input.kind === "blank") continue

        if (input.kind === "command") {
          if (input.name === "quit") return
          await command(agent, input.name)
          continue
        }

        received++
        await agent.receiveAndWait({
          channel: TERMINAL_CHANNEL,
          channelUserId,
          channelMessageId: `${sessionId}-in-${received}`,
          ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
          ...(input.kind === "tap"
            ? { action: { payload: input.payload }, text: input.label }
            : { text: input.text }),
        })
      }
    },
  }

  async function command(agent: Agent, name: string): Promise<void> {
    switch (name) {
      case "help":
        io.write(`${HELP}\n`)
        return

      case "version":
        io.write(`version ${agent.versionHash}\n`)
        return

      case "trace": {
        const rows = await agent.store.events.list(
          {},
          { orderBy: "seq", ascending: false, limit: 20 },
        )
        if (rows.length === 0) {
          io.write("Nothing recorded yet.\n")
          return
        }
        for (const row of [...rows].reverse()) {
          io.write(`  ${row.name} ${JSON.stringify(row.props)}\n`)
        }
        return
      }

      default:
        io.write(`No command :${name}. Try :help.\n`)
    }
  }
}

/** The real terminal. Lines from stdin, output to stdout. */
export function stdio(): ChatIo {
  return {
    lines: () => linesFrom(process.stdin),
    write: (text: string) => {
      process.stdout.write(text)
    },
  }
}

/** Splits a byte stream into lines, however the chunks happen to arrive. */
async function* linesFrom(input: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  let held = ""

  for await (const chunk of input) {
    held += decoder.decode(chunk, { stream: true })
    let newline = held.indexOf("\n")
    while (newline !== -1) {
      yield held.slice(0, newline).replace(/\r$/, "")
      held = held.slice(newline + 1)
      newline = held.indexOf("\n")
    }
  }

  if (held !== "") yield held.replace(/\r$/, "")
}
