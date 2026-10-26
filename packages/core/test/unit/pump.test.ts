// The pump, which the worker, the outbox and the jobs loop all are.
//
// These exist because of Known K14. SEND-4 ("one person's messages go out
// in order, never two at once") failed intermittently under the full run,
// and the state printed at the moment it failed said this:
//
//   0 turn(s) in flight, outbox pump busy 1, jobs pump busy 0
//   outbox:
//     seq 1 k-first sent after 1 attempt(s)
//     seq 2 k-second sent after 1 attempt(s)
//     seq 3 k-third sending after 0 attempt(s)
//
// Nothing was stolen and nothing overlapped. `settled()` had returned
// while the third message was claimed and still going out. A pass that is
// inside `candidates()` has already claimed its rows in the database, and
// until it puts them in `active` they are invisible: `busy()` says zero
// and `drain()` has nothing to wait for. That window is small, and under
// load it is wide enough to lose a message in.
import { test, expect, describe } from "bun:test"
import { createPump } from "../../src/runtime/pump.ts"

/** A promise someone else decides when to resolve. */
function gate(): { open: () => void; wait: Promise<void> } {
  let open = (): void => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait }
}

/** Lets anything already queued run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

/** Resolves to true when the promise is still pending after a tick or two. */
async function stillWaiting(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending")
  const first = await Promise.race([
    promise.then(() => "resolved"),
    new Promise((resolve) => setTimeout(() => resolve(marker), 20)),
  ])
  return first === marker
}

describe("K14: work a pass has claimed but not started", () => {
  test("K14: drain waits for a pass that is still claiming", async () => {
    // `candidates` stands for the conditional claim the outbox makes
    // (DATA-4): by the time it returns, the row says `sending` in the
    // database and no other process will take it.
    const claiming = gate()
    const handled: string[] = []
    // One row, once. A pump that keeps being offered the same work keeps
    // taking it, and this test is about the first pass, not the tenth.
    let served = false

    const pump = createPump<string>({
      pollMs: 10_000,
      concurrency: 2,
      candidates: async () => {
        await claiming.wait
        if (served) return []
        served = true
        return ["k-third"]
      },
      key: (item) => item,
      handle: async (item) => {
        handled.push(item)
      },
    })

    pump.start()
    const drained = pump.drain()

    // The pass is inside the claim. Nothing is in `active` yet, which is
    // exactly the state that used to look quiet.
    expect(pump.busy()).toBe(0)
    expect(await stillWaiting(drained)).toBe(true)

    claiming.open()
    await drained

    expect(handled).toEqual(["k-third"])
    await pump.stop()
  })

  test("K14: sweeping says a pass is in flight while busy still says nothing is", async () => {
    const claiming = gate()
    const pump = createPump<string>({
      pollMs: 10_000,
      concurrency: 1,
      candidates: async () => {
        await claiming.wait
        return []
      },
      key: (item) => item,
      handle: async () => {},
    })

    pump.start()
    expect(pump.busy()).toBe(0)
    expect(pump.sweeping()).toBe(true)

    claiming.open()
    await pump.drain()

    expect(pump.sweeping()).toBe(false)
    await pump.stop()
  })

  test("K14: stop waits for it too, so nothing is worked on after stop returns", async () => {
    // SEND-2: a row claimed in the database has to be finished, or it sits
    // in `sending` until the recovery sweep finds it. A stop that returns
    // first would also let one file's agent send during another file's
    // test, which is what K14's second suspect was.
    const claiming = gate()
    const handled: string[] = []

    const pump = createPump<string>({
      pollMs: 10_000,
      concurrency: 1,
      candidates: async () => {
        await claiming.wait
        return ["claimed"]
      },
      key: (item) => item,
      handle: async (item) => {
        handled.push(item)
      },
    })

    pump.start()
    const stopped = pump.stop()
    expect(await stillWaiting(stopped)).toBe(true)

    claiming.open()
    await stopped

    expect(handled).toEqual(["claimed"])
    expect(pump.running).toBe(false)
  })

  test("SEND-4: an item in flight is never taken a second time", async () => {
    // What SEND-4 rests on: the key is set in the same synchronous block
    // as the check that reads it, so two passes cannot both take one item.
    const holding = gate()
    const started: string[] = []

    const pump = createPump<string>({
      pollMs: 10_000,
      concurrency: 4,
      candidates: async () => ["one"],
      key: (item) => item,
      handle: async (item) => {
        started.push(item)
        await holding.wait
      },
    })

    pump.start()
    // Let the first pass claim it and start on it. `drain` is no use here:
    // the item is deliberately held, so draining would wait for the test.
    await settle()
    pump.nudge()
    pump.nudge()
    await settle()

    expect(started).toEqual(["one"])
    expect(pump.busy()).toBe(1)

    holding.open()
    await pump.stop()
  })
})
