// BRAIN-6, LOOP-10 and K3: the one way the core gives up waiting.
//
// Small millisecond values rather than a frozen clock, because a deadline
// is about real elapsed time. The file itself says why.
import { test, expect, describe } from "bun:test"
import { isTimeout, Timeout, waitNoLongerThan, withDeadline } from "../../src/runtime/deadline.ts"

const after = (ms: number, value = "done"): Promise<string> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms))

describe("BRAIN-6: a deadline on something we wait for", () => {
  test("BRAIN-6: work that finishes in time is returned untouched", async () => {
    const got = await withDeadline("the brain", 500, () => after(5, "an answer"))

    expect(got).toBe("an answer")
  })

  test("BRAIN-6: work that runs over throws a Timeout saying what and how long", async () => {
    const error = (await withDeadline("the brain", 20, () => after(5_000)).catch(
      (e: unknown) => e,
    )) as Timeout

    expect(error).toBeInstanceOf(Timeout)
    expect(error.what).toBe("the brain")
    expect(error.ms).toBe(20)
    expect(error.message).toContain("the brain")
    expect(error.message).toContain("20ms")
  })

  test("K10: the signal is aborted, so the request is cancelled and not abandoned", async () => {
    // The whole of K10 in one assertion. A timed out request that is still
    // in flight is still billed and still holding a connection.
    let aborted: unknown
    await withDeadline("the decision model", 20, async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = signal.reason
      })
      return after(5_000)
    }).catch(() => {})

    expect(isTimeout(aborted)).toBe(true)
    expect((aborted as Timeout).what).toBe("the decision model")
  })

  test("K10: the signal is handed over before the deadline, not only after", async () => {
    // So a provider can pass it to `fetch` at the start of the call.
    let given: AbortSignal | undefined
    await withDeadline("a tool", 200, async (signal) => {
      given = signal
      return "fine"
    })

    expect(given).toBeInstanceOf(AbortSignal)
    expect(given?.aborted).toBe(false)
  })

  test("K3: the timer is cleared when the work wins, so nothing fires later", async () => {
    // A timer left behind keeps the process alive after the work it
    // belonged to has finished, which is half of what K3 is about. A
    // leaked timer is hard to see directly, so this watches its effect:
    // if it were still pending it would abort this signal once the
    // deadline passed, long after the work was done.
    let signal: AbortSignal | undefined
    await withDeadline("the brain", 30, async (given) => {
      signal = given
      return "fast"
    })

    expect(signal?.aborted).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(signal?.aborted).toBe(false)
  })

  test("a work rejection is passed through as itself, not as a timeout", async () => {
    const error = (await withDeadline("a tool", 500, async () => {
      throw new Error("the tool itself broke")
    }).catch((e: unknown) => e)) as Error

    expect(error.message).toBe("the tool itself broke")
    expect(isTimeout(error)).toBe(false)
  })

  test("a deadline of zero means no deadline, so a builder can turn one off", async () => {
    const got = await withDeadline("the brain", 0, () => after(5, "still answered"))

    expect(got).toBe("still answered")
  })

  test("isTimeout recognises one across a rethrow that loses the class", async () => {
    // A brain adapter may wrap what it caught. The name survives
    // structured copying and a plain `{ ...error }` does not keep the
    // prototype, so the check is on the name as well.
    const plain = Object.assign(new Error("x"), { name: "Timeout" })
    expect(isTimeout(plain)).toBe(true)
    expect(isTimeout(new Error("x"))).toBe(false)
    expect(isTimeout("Timeout")).toBe(false)
  })
})

describe("K3: a deadline on stopping", () => {
  test("K3: work that drains in time reports that it finished", async () => {
    expect(await waitNoLongerThan(500, after(5))).toBe("finished")
  })

  test("K3: work that will not drain is given up on rather than waited for", async () => {
    // The difference between a deploy that drains slowly and one that
    // never drains. Nothing is cancelled: a turn mid flight is answering
    // somebody, and killing it would lose the answer.
    expect(await waitNoLongerThan(20, after(5_000))).toBe("gave up")
  })

  test("K3: a deadline of zero waits as long as it takes", async () => {
    expect(await waitNoLongerThan(0, after(5))).toBe("finished")
  })

  test("K3: giving up does not reject, because stopping is not a failure", async () => {
    // `stop()` is called in a cleanup hook and in a signal handler. A
    // throw there would turn a slow drain into a crash on the way out.
    const slow = after(5_000)
    await expect(waitNoLongerThan(20, slow)).resolves.toBe("gave up")
  })
})
