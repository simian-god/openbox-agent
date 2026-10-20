// SKILL-6: the terminal channel `openbox chat` talks through.
//
// The parts with a decision in them are pure functions, so they are tested
// here without a terminal, a database or an agent. The loop itself is
// proven end to end in test/integration/chat.test.ts.
import { test, expect, describe } from "bun:test"
import {
  readLine,
  formatOutbound,
  terminalChannel,
  TERMINAL_CHANNEL,
  type ChatIo,
} from "../../src/cli/terminal.ts"

const BUTTONS = [
  { label: "Confirm", payload: "confirm:abc" },
  { label: "Cancel", payload: "cancel:abc" },
]

/** An io that answers from a list and collects what was written. */
function fakeIo(input: string[] = []): ChatIo & { written: string[]; text(): string } {
  const written: string[] = []
  return {
    written,
    text: () => written.join(""),
    lines: async function* () {
      for (const line of input) yield line
    },
    write: (text: string) => {
      written.push(text)
    },
  }
}

describe("SKILL-6: reading a typed line", () => {
  test("SKILL-6: plain words are a message to the agent", () => {
    expect(readLine("Any space on Monday?", [])).toEqual({
      kind: "text",
      text: "Any space on Monday?",
    })
  })

  test("SKILL-6: surrounding space is trimmed", () => {
    expect(readLine("  hello  ", [])).toEqual({ kind: "text", text: "hello" })
  })

  test("SKILL-6: an empty line is nothing, not an empty message", () => {
    expect(readLine("", [])).toEqual({ kind: "blank" })
    expect(readLine("   ", [])).toEqual({ kind: "blank" })
  })

  test("SKILL-6: chat's own commands start with a colon", () => {
    expect(readLine(":quit", [])).toEqual({ kind: "command", name: "quit" })
    expect(readLine(":q", [])).toEqual({ kind: "command", name: "quit" })
    expect(readLine(":help", [])).toEqual({ kind: "command", name: "help" })
    expect(readLine(":VERSION", [])).toEqual({ kind: "command", name: "version" })
  })

  test("SKILL-6: a slash reaches the agent, so an operator command can be typed", () => {
    // HAND's operator commands are messages, not chat commands. Chat must
    // not swallow them, which is why its own commands use a colon.
    expect(readLine("/take", [])).toEqual({ kind: "text", text: "/take" })
  })

  test("SKILL-6: a number taps the button at that position", () => {
    expect(readLine("1", BUTTONS)).toEqual({
      kind: "tap",
      label: "Confirm",
      payload: "confirm:abc",
    })
    expect(readLine("2", BUTTONS)).toEqual({ kind: "tap", label: "Cancel", payload: "cancel:abc" })
  })

  test("SKILL-6: a button's label taps it too, whatever the case", () => {
    expect(readLine("cancel", BUTTONS)).toEqual({
      kind: "tap",
      label: "Cancel",
      payload: "cancel:abc",
    })
  })

  test("SKILL-6: a number past the end of the list is just a message", () => {
    expect(readLine("3", BUTTONS)).toEqual({ kind: "text", text: "3" })
    expect(readLine("0", BUTTONS)).toEqual({ kind: "text", text: "0" })
  })

  test("SKILL-6: with no buttons offered, a number is a message", () => {
    expect(readLine("1", [])).toEqual({ kind: "text", text: "1" })
  })

  test("SKILL-6: a command still wins while buttons are on offer", () => {
    expect(readLine(":quit", BUTTONS)).toEqual({ kind: "command", name: "quit" })
  })
})

describe("SKILL-6: showing what the agent sent", () => {
  test("SKILL-6: text is shown as it stands", () => {
    expect(formatOutbound({ text: "We open at 11." })).toBe("We open at 11.")
  })

  test("SKILL-6: buttons are numbered, so they can be typed", () => {
    const shown = formatOutbound({ text: "Book a table for 2?", buttons: BUTTONS })
    expect(shown).toContain("Book a table for 2?")
    expect(shown).toContain("[1] Confirm")
    expect(shown).toContain("[2] Cancel")
  })

  test("SKILL-6: buttons with no text of their own still show", () => {
    expect(formatOutbound({ buttons: BUTTONS })).toContain("[1] Confirm")
  })

  test("SKILL-6: a message with nothing in it says so rather than printing blank", () => {
    expect(formatOutbound({})).toContain("nothing")
  })

  test("SKILL-6: a file or a template is named, since a terminal cannot show one", () => {
    expect(
      formatOutbound({ file: { url: "u", name: "menu.pdf", mime: "application/pdf" } }),
    ).toContain("menu.pdf")
    expect(formatOutbound({ template: { name: "reminder", vars: { when: "7pm" } } })).toContain(
      "reminder",
    )
  })
})

describe("SKILL-6: the channel", () => {
  test("SKILL-6: it says what a terminal can and cannot do", () => {
    const channel = terminalChannel({ io: fakeIo() })
    const can = channel.sender.capabilities(TERMINAL_CHANNEL)

    // Buttons are printed and typed back by number, so they work here.
    expect(can.buttons).toBe(true)
    // A terminal cannot deliver either of these.
    expect(can.files).toBe(false)
    expect(can.templates).toBe(false)
    // Printing twice shows twice, so a repeat send is not harmless.
    expect(can.idempotentSends).toBe(false)
    expect(can.windowHours).toBeUndefined()
  })

  test("SKILL-6: sending prints the message and reports it sent", async () => {
    const io = fakeIo()
    const channel = terminalChannel({ io })

    const result = await channel.sender.send({
      channel: TERMINAL_CHANNEL,
      channelUserId: "local",
      text: "We open at 11.",
      idempotencyKey: "t1:reply",
    })

    expect(result.status).toBe("sent")
    expect(io.text()).toContain("We open at 11.")
  })

  test("SKILL-6: every send gets its own channel message id", async () => {
    const channel = terminalChannel({ io: fakeIo() })
    const out = {
      channel: TERMINAL_CHANNEL,
      channelUserId: "local",
      text: "hi",
      idempotencyKey: "k",
    }

    const first = await channel.sender.send(out)
    const second = await channel.sender.send({ ...out, idempotencyKey: "k2" })

    expect(first).not.toEqual(second)
  })

  test("SKILL-6: buttons just sent are the ones a number taps", async () => {
    const channel = terminalChannel({ io: fakeIo() })
    expect(channel.buttons()).toEqual([])

    await channel.sender.send({
      channel: TERMINAL_CHANNEL,
      channelUserId: "local",
      text: "Book it?",
      buttons: BUTTONS,
      idempotencyKey: "k",
    })
    expect(channel.buttons()).toEqual(BUTTONS)

    // A later message with no buttons clears them, so a stale number
    // cannot tap something the person can no longer see.
    await channel.sender.send({
      channel: TERMINAL_CHANNEL,
      channelUserId: "local",
      text: "Done.",
      idempotencyKey: "k2",
    })
    expect(channel.buttons()).toEqual([])
  })
})
