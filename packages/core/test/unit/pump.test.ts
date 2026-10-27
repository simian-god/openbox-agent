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
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createPump } from "../../src/runtime/pump.ts"
import { tsFiles, withoutComments } from "../support/source.ts"

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
  // The two below are about `onError`, which nothing covered until the
  // cleanup sweep went looking. Both take their candidates from a queue
  // that drains, and both yield to the macrotask queue on every pass.
  //
  // That is not style, it is the price of a readable failure. A fake
  // `candidates` that keeps returning the same item while `handle` fails
  // immediately is a closed loop: the item's `finally` nudges the pump,
  // the pump sweeps, the fake hands the item back. Nothing in that circuit
  // awaits a timer, so it never leaves the microtask queue, so the test
  // runner's own timeout, which is a timer, never gets to fire. The result
  // is not a failing test. It is a pinned core, an array that grows until
  // the machine gives out, and no output at all. `pass()` has no floor of
  // its own by design, since a real `candidates` is a database read and an
  // item normally stops being a candidate once it is claimed, so the only
  // thing standing between a fake and a locked up machine is the fake.
  //
  // `quiet()` already carries the same guard for the same reason, with the
  // same reasoning written beside it in pump.ts.

  /** Hands each item out once, and always yields before answering. */
  function queued(items: string[]): (slots: number) => Promise<string[]> {
    const left = [...items]
    return async (slots: number) => {
      await settle()
      return left.splice(0, Math.max(1, slots))
    }
  }

  test("a handler that throws is reported to onError, not swallowed", async () => {
    // Deleting the outbox's own unused copy of this wrapper only holds if
    // the pump really does report. Nothing proved that it did. All three
    // pumps, the worker, the outbox and the jobs loop, hand the builder's
    // `onWorkerError` down to here.
    const seen: unknown[] = []
    const pump = createPump<string>({
      pollMs: 10_000,
      concurrency: 1,
      candidates: queued(["one"]),
      key: (item) => item,
      handle: async () => {
        throw new Error("the database went away")
      },
      onError: (error) => seen.push(error),
    })

    pump.start()
    await pump.drain()
    await pump.stop()

    expect(seen).toHaveLength(1)
    expect((seen[0] as Error).message).toBe("the database went away")
  }, 5_000)

  test("an onError that throws does not stop the pump", async () => {
    // The rule the event writer already follows: a broken handler of the
    // builder's must never become the reason work stops going out. Here
    // the first item fails and the reporter for that failure fails too,
    // and the second item still has to be worked on.
    const handled: string[] = []
    const pump = createPump<string>({
      pollMs: 10_000,
      concurrency: 1,
      candidates: queued(["one", "two"]),
      key: (item) => item,
      handle: async (item) => {
        handled.push(item)
        if (item === "one") throw new Error("first one fails")
      },
      onError: () => {
        throw new Error("and the handler for that is broken too")
      },
    })

    pump.start()
    await pump.drain()
    await pump.stop()

    expect(handled).toEqual(["one", "two"])
  }, 5_000)
})

describe("every pump reports, because a pump that cannot is a silent one", () => {
  // A probe during the cleanup removed the line that hands `onError` from
  // the outbox down to its pump, and nothing failed. The two tests above
  // prove the pump reports what it is given; this is the other half, that
  // each of the three pumps is actually given it. Structural, in the shape
  // DEP-1, DATA-1 and TIME-1 are already enforced in, because the thing
  // worth preventing is a fourth pump arriving without it.
  const root = join(import.meta.dir, "..", "..", "src")

  /** The option object of each `createPump` call in a file. */
  function pumpCalls(text: string): string[] {
    const found: string[] = []
    for (const match of text.matchAll(/createPump\s*(?:<[^>]*>)?\s*\(/g)) {
      let depth = 0
      let start = -1
      for (let i = (match.index ?? 0) + match[0].length - 1; i < text.length; i++) {
        const ch = text[i]
        if (ch === "(" || ch === "{") {
          if (depth === 0) start = i
          depth++
        } else if (ch === ")" || ch === "}") {
          depth--
          if (depth === 0) {
            found.push(text.slice(start, i + 1))
            break
          }
        }
      }
    }
    return found
  }

  test("each createPump is handed an onError", () => {
    const callers = tsFiles(root).filter(
      (file) =>
        file !== "runtime/pump.ts" && readFileSync(join(root, file), "utf8").includes("createPump"),
    )
    // index.ts only re-exports it.
    const real = callers.filter((file) => file !== "index.ts")
    expect(real.sort()).toEqual(["runtime/jobs.ts", "runtime/outbox.ts", "runtime/worker.ts"])

    const missing: string[] = []
    for (const file of real) {
      const calls = pumpCalls(withoutComments(readFileSync(join(root, file), "utf8")))
      expect(calls).toHaveLength(1)
      for (const call of calls) {
        if (!call.includes("onError")) missing.push(file)
      }
    }
    expect(missing).toEqual([])
  })

  test("that rule can actually fail", () => {
    // The rule is worth its parser and no more, so this pins the parser.
    expect(pumpCalls("const p = createPump<Row>({ pollMs: 1, onError })")[0]).toContain("onError")
    expect(pumpCalls("const p = createPump<Row>({ pollMs: 1 })")[0]).not.toContain("onError")
    // A nested object must not end the call early and hide a missing one.
    const nested = pumpCalls("createPump<Row>({ a: { b: 1 }, handle: async () => {}, onError })")
    expect(nested).toHaveLength(1)
    expect(nested[0]).toContain("onError")
    expect(pumpCalls("createPump<Row>({ a: { b: 1 }, handle: async () => {} })")[0]).not.toContain(
      "onError",
    )
  })
})
