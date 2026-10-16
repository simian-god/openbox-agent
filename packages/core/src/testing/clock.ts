// TIME-1: all time comes from the injected clock. A test that needs a
// particular Tuesday, or needs to cross midnight, moves this one by hand.

export interface Clock {
  now(): Date
}

export interface FixedClock extends Clock {
  /** Moves time forward. Negative goes back. */
  advance(ms: number): void
  /** Jumps to an exact instant. */
  set(at: Date | string): void
}

export function fixedClock(start: Date | string = "2026-10-16T12:00:00.000Z"): FixedClock {
  let at = new Date(start)

  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at = new Date(at.getTime() + ms)
    },
    set: (next: Date | string) => {
      at = new Date(next)
    },
  }
}

/** The real clock, for an agent actually running. */
export const systemClock: Clock = { now: () => new Date() }
