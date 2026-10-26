// Every agent an integration test builds goes through here (Known K14,
// step 2).
//
// The clearest remaining suspect for the intermittent stall is an agent
// escaping its file's `afterEach`. A leaked agent keeps polling the same
// database: it slows everything down and it claims rows another file's
// test is waiting for, which looks exactly like the two failures we have
// seen. Every file had its own `started` array, so nothing could tell.
//
// This registry is shared by every file in the run, so each file's
// `afterEach` can stop its own agents and then say whether anything from
// any other file is still going, by name. That either finds the leak or
// removes the suspect for good.
import { afterAll, afterEach, expect } from "bun:test"
import {
  createAgent as buildAgent,
  type Agent,
  type AgentOptions,
} from "../../src/runtime/index.ts"

interface Live {
  agent: Agent
  /** The test file that built it, so a leak names its own culprit. */
  file: string
  /** Whether it was started, since only a started one polls. */
  started: boolean
}

/** Every tracked agent that has not been stopped. Shared across files. */
const live = new Set<Live>()

/** What is still running, as one line per agent. */
export function stillRunning(): string[] {
  return [...live].map(
    (entry) =>
      `${entry.file}: ${entry.agent.config.name} as ${entry.agent.owner}${
        entry.started ? "" : " (never started)"
      }, ${entry.agent.inFlight()} turn(s) in flight`,
  )
}

export interface TrackedAgents {
  /** Builds it, starts it and tracks it. */
  create(options: AgentOptions): Agent
  /** Builds and tracks it without starting, for a test driving the loop by hand. */
  build(options: AgentOptions): Agent
  /** Tracks one that was built elsewhere, so it is still stopped. */
  track(agent: Agent): Agent
  /** Stops this file's agents now, rather than waiting for `afterEach`. */
  stopAll(): Promise<void>
}

export interface TrackOptions {
  /**
   * Run before anything is stopped.
   *
   * Some files hold a brain open on a gate so nothing has to sleep. An
   * agent whose brain is still waiting would never finish stopping, so
   * those gates have to be opened first. Declared here rather than left
   * to the order two `afterEach` hooks happen to run in.
   */
  beforeStop?: (() => void | Promise<void>) | undefined
}

/**
 * Tracks the agents one test file makes, and cleans up after each test.
 *
 * `file` is passed rather than guessed from a stack, so the message a
 * leak prints is exact.
 */
export function trackAgents(file: string, hooks: TrackOptions = {}): TrackedAgents {
  const mine = new Set<Live>()

  const track = (agent: Agent, started: boolean): Agent => {
    const entry: Live = { agent, file, started }
    live.add(entry)
    mine.add(entry)
    return agent
  }

  const stopAll = async (): Promise<void> => {
    await hooks.beforeStop?.()
    const entries = [...mine]
    mine.clear()
    // Stopping is what must happen, whatever a stop throws.
    const results = await Promise.allSettled(entries.map((entry) => entry.agent.stop()))
    // Dropped either way. A stop that failed is reported by the throw
    // below, and keeping it here would fail every later test in the run
    // for something one test already said out loud.
    for (const entry of entries) live.delete(entry)
    const failed = results.filter((result) => result.status === "rejected")
    if (failed.length > 0) {
      throw new Error(
        `${file}: ${failed.length} agent(s) would not stop: ${failed
          .map((result) => String((result as PromiseRejectedResult).reason))
          .join("; ")}`,
      )
    }
  }

  afterEach(async () => {
    await stopAll()
    // Nothing from any file may still be polling the shared database.
    expect(stillRunning()).toEqual([])
  })

  // The same again at the end, for a leak the last test created.
  afterAll(() => {
    expect(stillRunning()).toEqual([])
  })

  return {
    create(options: AgentOptions): Agent {
      const agent = buildAgent(options)
      agent.start()
      return track(agent, true)
    },
    build(options: AgentOptions): Agent {
      return track(buildAgent(options), false)
    },
    track(agent: Agent): Agent {
      return track(agent, true)
    },
    stopAll,
  }
}
