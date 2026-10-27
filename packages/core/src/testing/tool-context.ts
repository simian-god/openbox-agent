// TEST-3: a `ctx` for testing one tool on its own.
//
// Every agent builder writes tools, and a tool is the easiest thing in an
// agent to test: give it arguments and a context, and check what it did.
// Without this they would hand build a `ToolContext` object literal, which
// means every one of them breaks the day the core adds a field to it. That
// happened here first, in nine places, when `ctx.time` arrived.
import type { OpenboxConfig } from "../config/index.ts"
import type { Store } from "../store/index.ts"
import { createTimeHelpers } from "../time/index.ts"
import type { ToolContext } from "../tools/index.ts"
import { systemClock, type Clock } from "./clock.ts"

export interface FakeToolContextOptions {
  config: OpenboxConfig
  /** The agent's own tables. A real store, or anything with `table`. */
  db?: ToolContext["db"] | Store | undefined
  clock?: Clock | undefined
  /** Who the tool is acting for. Only `id` usually matters to a test. */
  person?: Partial<ToolContext["person"]> | undefined
  /** TOOL-4: what is remembered about this person. */
  facts?: Record<string, string> | undefined
  /** Every line the tool logged, so a test can read them. */
  logged?: string[] | undefined
  /**
   * MEDIA-4: every file the tool sent, so a test can read them.
   *
   * Given an array, `ctx.sendFile` pushes into it and resolves. Left out,
   * sending a file throws, which is the right default: a tool that sends
   * one is doing something a test should have opted into seeing.
   */
  filesSent?: { file: { url: string; name: string; mime: string }; caption?: string }[] | undefined
}

/** A `ToolContext` for a test, with everything a tool is promised (TOOL-4). */
export function fakeToolContext(options: FakeToolContextOptions): ToolContext {
  const clock = options.clock ?? systemClock
  const logged = options.logged ?? []

  const filesSent = options.filesSent

  return {
    clock,
    time: createTimeHelpers({ config: options.config, clock }),
    sendFile: async (file, sendOptions) => {
      if (filesSent === undefined) {
        throw new Error("this test did not expect the tool to send a file")
      }
      filesSent.push({
        file,
        ...(sendOptions?.caption !== undefined ? { caption: sendOptions.caption } : {}),
      })
    },
    facts: Object.freeze({ ...options.facts }),
    person: {
      id: "00000000-0000-0000-0000-000000000001",
      role: "end_user",
      channel: "test",
      channelUserId: "tester",
      displayName: null,
      language: null,
      ...options.person,
    },
    db: options.db ?? { table: () => undefined },
    log: (message: string) => {
      logged.push(message)
    },
  }
}
