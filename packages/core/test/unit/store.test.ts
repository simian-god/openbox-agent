import { test, expect, describe } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createStore, type Store } from "../../src/store/index.ts"
import { readCode, tsFiles, withoutComments } from "../support/source.ts"

/** One call the store made, flattened so a test can read it. */
type Recorded = {
  table: string
  operation: string
  filters: [string, unknown][]
  payload?: unknown
}

/**
 * A stand in for supabase-js that records what was asked of it. Only the
 * parts the store uses are implemented.
 */
function recordingClient(rows: unknown[] = []): { db: SupabaseClient; calls: Recorded[] } {
  const calls: Recorded[] = []

  const builder = (call: Recorded) => {
    const chain = {
      eq(column: string, value: unknown) {
        call.filters.push([column, value])
        return chain
      },
      select(_columns?: string, _options?: unknown) {
        return chain
      },
      order() {
        return chain
      },
      limit() {
        return chain
      },
      // Awaiting the builder is what sends the query.
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve)
      },
    }
    return chain
  }

  const db = {
    from(table: string) {
      return {
        select(_columns?: string, _options?: unknown) {
          const call: Recorded = { table, operation: "select", filters: [] }
          calls.push(call)
          return builder(call)
        },
        insert(payload: unknown) {
          const call: Recorded = { table, operation: "insert", filters: [], payload }
          calls.push(call)
          return builder(call)
        },
        update(payload: unknown) {
          const call: Recorded = { table, operation: "update", filters: [], payload }
          calls.push(call)
          return builder(call)
        },
        delete() {
          const call: Recorded = { table, operation: "delete", filters: [] }
          calls.push(call)
          return builder(call)
        },
      }
    },
  } as unknown as SupabaseClient

  return { db, calls }
}

const agentIdFilter = (call: Recorded) => call.filters.find(([column]) => column === "agent_id")

/** Every typed accessor the store exposes. */
const accessors = ["people", "versions", "turns", "inbox", "messages", "events"] as const

describe("DATA-1: every query is scoped to the agent", () => {
  test("DATA-1: every read filters on agent_id", async () => {
    for (const accessor of accessors) {
      const { db, calls } = recordingClient()
      const store = createStore(db, "restaurant")
      await store[accessor].list()

      expect(agentIdFilter(calls[0] as Recorded)).toEqual(["agent_id", "restaurant"])
    }
  })

  test("DATA-1: every insert stamps agent_id onto the row", async () => {
    for (const accessor of accessors) {
      const { db, calls } = recordingClient([{ id: "1" }])
      const store = createStore(db, "restaurant")
      await store[accessor].insert({ note: "x" } as never)

      expect(calls[0]?.payload).toEqual([{ note: "x", agent_id: "restaurant" }])
    }
  })

  test("DATA-1: every update filters on agent_id", async () => {
    for (const accessor of accessors) {
      const { db, calls } = recordingClient([])
      const store = createStore(db, "restaurant")
      await store[accessor].update({ id: "1" }, { note: "y" })

      expect(agentIdFilter(calls[0] as Recorded)).toEqual(["agent_id", "restaurant"])
    }
  })

  test("DATA-1: every delete filters on agent_id", async () => {
    for (const accessor of accessors) {
      const { db, calls } = recordingClient([])
      const store = createStore(db, "restaurant")
      await store[accessor].remove({ id: "1" })

      expect(agentIdFilter(calls[0] as Recorded)).toEqual(["agent_id", "restaurant"])
    }
  })

  test("DATA-1: counting filters on agent_id too", async () => {
    const { db, calls } = recordingClient([])
    await createStore(db, "restaurant").people.count()

    expect(agentIdFilter(calls[0] as Recorded)).toEqual(["agent_id", "restaurant"])
  })

  test("DATA-1: an untyped table is scoped just the same", async () => {
    const { db, calls } = recordingClient([])
    await createStore(db, "restaurant").table("menu_items").list()

    expect(calls[0]?.table).toBe("menu_items")
    expect(agentIdFilter(calls[0] as Recorded)).toEqual(["agent_id", "restaurant"])
  })

  test("DATA-1: an update cannot move a row to another agent", async () => {
    const { db, calls } = recordingClient([])
    const store = createStore(db, "restaurant")
    await store.people.update({ id: "1" }, { agent_id: "someone-else", blocked: true })

    expect(calls[0]?.payload).toEqual({ blocked: true })
  })

  test("DATA-1: an insert cannot write to another agent", async () => {
    const { db, calls } = recordingClient([{ id: "1" }])
    const store = createStore(db, "restaurant")
    await store.people.insert({ agent_id: "someone-else", channel: "web" } as never)

    expect(calls[0]?.payload).toEqual([{ agent_id: "restaurant", channel: "web" }])
  })

  test("DATA-1: a caller's own filters are added on top of the scope", async () => {
    const { db, calls } = recordingClient([])
    await createStore(db, "restaurant").people.find({ channel: "web", channel_user_id: "42" })

    expect(calls[0]?.filters).toEqual([
      ["agent_id", "restaurant"],
      ["channel", "web"],
      ["channel_user_id", "42"],
    ])
  })

  test("DATA-1: a store cannot be built without an agent", () => {
    const { db } = recordingClient()
    expect(() => createStore(db, "")).toThrow(/agentId/)
  })
})

describe("DATA-1: the scope is in one place", () => {
  // The rule holds because there is exactly one call site, not because
  // every method remembers to add the filter. This is the test that keeps
  // it that way.
  test("DATA-1: only the scoped helper reaches the database", () => {
    const storeDir = join(import.meta.dir, "..", "..", "src", "store")
    const callSites = tsFiles(storeDir).flatMap((file) => [
      ...readCode(storeDir, file).matchAll(/\bdb\.from\s*\(/g),
    ])
    expect(callSites).toHaveLength(1)
  })

  test("DATA-1: nothing outside the store reaches a core table directly", () => {
    const srcDir = join(import.meta.dir, "..", "..", "src")

    // Strings are kept here, since the table's name is the thing being
    // looked for. Comments are not.
    const offenders = tsFiles(srcDir).filter(
      (file) =>
        !file.startsWith("store/") &&
        /\.from\s*\(\s*["'`]ob_/.test(withoutComments(readFileSync(join(srcDir, file), "utf8"))),
    )
    expect(offenders).toEqual([])
  })
})

describe("what the store gives back", () => {
  test("DATA-1: find returns null rather than throwing when nothing matches", async () => {
    const { db } = recordingClient([])
    expect(await createStore(db, "a").people.find({ id: "nope" })).toBeNull()
  })

  test("DATA-1: inserting nothing asks the database nothing", async () => {
    const { db, calls } = recordingClient([])
    const result = await createStore(db, "a").people.insertMany([])

    expect(result).toEqual([])
    expect(calls).toEqual([])
  })

  test("DATA-1: the store says which agent it is scoped to", () => {
    const { db } = recordingClient()
    const store: Store = createStore(db, "restaurant")
    expect(store.agentId).toBe("restaurant")
  })
})
