// A terminal that types a fixed list of lines and records what was shown,
// so the chat loop can be driven without a tty.
import type { ChatIo } from "../../src/cli/terminal.ts"

export interface FakeIo extends ChatIo {
  readonly written: string[]
  text(): string
}

export function fakeIo(input: string[] = []): FakeIo {
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
