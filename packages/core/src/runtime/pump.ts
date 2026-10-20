// The part every worker in the core has in common.
//
// There are three of them by the end: the inbox worker that turns waiting
// messages into turns (LOOP-2), the outbox worker that gets replies out,
// and the job loop. They differ in what they look for and what they do
// with it. They do not differ in how they poll, how many things they take
// at once, how they are nudged, or what stopping means, and those are
// exactly the parts where a quiet difference between two copies would be
// a bug nobody notices until a deploy hangs.
//
// Built for more than one process: a pump reads a bounded, indexed list of
// candidates and claims each one, so its cost does not grow with the size
// of the table and two pumps racing is settled by the claim rather than by
// hoping they look at different rows.

export interface PumpOptions<Item> {
  /** How often to look, when nothing nudges it. */
  pollMs: number
  /** How many items to work on at once. */
  concurrency: number
  /**
   * What is worth trying, given how many free slots there are. More than
   * `slots` is useful: a pump that loses a race to another process should
   * still find something else to do.
   */
  candidates: (slots: number) => Promise<Item[]>
  /** What identifies an item, so the same one is never taken twice here. */
  key: (item: Item) => string
  /** Does the work. A rejection is reported, never thrown onwards. */
  handle: (item: Item) => Promise<void>
  onError?: ((error: unknown) => void) | undefined
}

export interface Pump {
  start(): void
  /** Stops looking, then waits for the work in flight. */
  stop(): Promise<void>
  /** Look now rather than on the next poll. Never throws. */
  nudge(): void
  /** Waits for the work in flight, without stopping. */
  drain(): Promise<void>
  busy(): number
  readonly running: boolean
}

export function createPump<Item>(options: PumpOptions<Item>): Pump {
  const { pollMs, concurrency, candidates, key, handle, onError } = options

  const active = new Map<string, Promise<void>>()
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Set while a sweep is in progress, so two never overlap. */
  let sweeping = false
  /** True when a nudge arrived during a sweep, so one more is owed. */
  let again = false

  const report = (error: unknown): void => {
    try {
      onError?.(error)
    } catch {
      // A broken handler must not stop the pump looking for work.
    }
  }

  async function sweep(): Promise<void> {
    if (sweeping) {
      again = true
      return
    }
    sweeping = true

    try {
      do {
        again = false
        const slots = concurrency - active.size
        if (slots <= 0) return

        for (const item of await candidates(slots)) {
          if (active.size >= concurrency) break
          const id = key(item)
          if (active.has(id)) continue

          const work = handle(item)
            .catch(report)
            .finally(() => {
              active.delete(id)
              // A finished item frees a slot and there may be more
              // waiting, so look again rather than wait for the poll.
              if (running) nudge()
            })
          active.set(id, work)
        }
      } while (again)
    } catch (error) {
      report(error)
    } finally {
      sweeping = false
    }
  }

  function schedule(): void {
    if (!running) return
    timer = setTimeout(() => {
      void sweep().finally(schedule)
    }, pollMs)
  }

  function nudge(): void {
    if (!running) return
    void sweep()
  }

  return {
    get running() {
      return running
    },

    start(): void {
      if (running) return
      running = true
      // Look straight away, so work already waiting is not held for one
      // poll interval before anything happens.
      void sweep()
      schedule()
    },

    async stop(): Promise<void> {
      running = false
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      while (active.size > 0) await Promise.all([...active.values()])
    },

    nudge,

    async drain(): Promise<void> {
      while (active.size > 0) await Promise.all([...active.values()])
    },

    busy: () => active.size,
  }
}

/** A delay a pump can wait on, from the injected clock's point of view. */
export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
