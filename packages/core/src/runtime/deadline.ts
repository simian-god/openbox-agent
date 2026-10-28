// BRAIN-6, LOOP-10 and the deadline on `stop()`: one way to give up
// waiting, used everywhere the core waits on somebody else.
//
// Three places needed this and each could have grown its own version: a
// brain call (BRAIN-6), a tool call (LOOP-10), and a decision request
// (ROUTE-5, which had a timer already and nothing to cancel with). Three
// copies of a race against a timer is three chances to forget to clear
// it, and a timer nobody clears holds the process open, which is the
// exact bug this row exists to fix.
//
// Giving up and cancelling are deliberately the same act. Known K10 is
// what happens when they are not: a decision request timed out, the step
// carried on, and the request stayed in flight, still billed, still
// holding a connection. So the signal is aborted with the same error the
// caller sees, which is what lets a provider's `fetch` stop rather than
// run to completion for nobody.
//
// Real timers, not the injected clock. A deadline is about how long a
// person has actually been waiting, not about what the agent thinks the
// time is, and a frozen clock in a test must not freeze a timeout into
// never firing. `limits.ts` says the same thing about its jitter for the
// same reason. Tests here pass small millisecond values instead.

/** What `withDeadline` throws, and what it aborts the signal with. */
export class Timeout extends Error {
  /** What was being waited on, for a message somebody can act on. */
  readonly what: string
  readonly ms: number

  constructor(what: string, ms: number) {
    super(`${what} took longer than ${ms}ms`)
    this.name = "Timeout"
    this.what = what
    this.ms = ms
  }
}

/** True for the error this file throws, including across a rethrow. */
export const isTimeout = (error: unknown): error is Timeout =>
  error instanceof Timeout || (error instanceof Error && error.name === "Timeout")

/**
 * Runs something with a deadline, and cancels it when the deadline passes.
 *
 * `run` is handed an `AbortSignal` and is expected to pass it on to
 * whatever it waits for. A `run` that ignores it still times out from the
 * caller's point of view; what is lost is the cancelling, which is K10's
 * cost rather than a correctness problem.
 *
 * `ms` of zero or less means no deadline at all, so a builder can turn one
 * off in config without this file growing a second code path.
 */
export async function withDeadline<T>(
  what: string,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (ms <= 0) return run(new AbortController().signal)

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const timeout = new Timeout(what, ms)
      // Aborted first, so the request is already on its way to stopping
      // by the time the caller hears about it.
      controller.abort(timeout)
      reject(timeout)
    }, ms)
  })

  try {
    return await Promise.race([run(controller.signal), expired])
  } finally {
    // Always, including when `run` won. A timer left behind is what keeps
    // a process alive after the work it belonged to has finished.
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Waits for something, but not past a deadline, and says which happened.
 *
 * For a shutdown rather than a request. `stop()` cannot cancel the turn it
 * is waiting for, because a turn mid flight is answering somebody and
 * killing it would lose the answer. What it can do is stop waiting and say
 * so, which is the difference between a deploy that drains slowly and one
 * that never drains at all (Known K3).
 */
export async function waitNoLongerThan(
  ms: number,
  work: Promise<unknown>,
): Promise<"finished" | "gave up"> {
  if (ms <= 0) {
    await work
    return "finished"
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<"gave up">((resolve) => {
    timer = setTimeout(() => resolve("gave up"), ms)
  })

  try {
    return await Promise.race([work.then(() => "finished" as const), gaveUp])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
