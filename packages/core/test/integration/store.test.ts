// The store against a real supabase-js client and a real PostgREST, so
// the agent_id scope is proven end to end and not only against a fake.
import { test, expect, beforeAll, beforeEach } from "bun:test"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { createStore, type Store } from "../../src/store/index.ts"

describeDatabase("the store", (sql) => {
  let restaurant: Store
  let dentist: Store

  beforeAll(async () => {
    const db = localSupabase("service_role")
    restaurant = createStore(db, "restaurant")
    dentist = createStore(db, "dentist")
  })

  // Every test starts from an empty table, so one test's rows cannot
  // change what another sees.
  beforeEach(async () => {
    await resetDatabase(sql())
  })

  const newPerson = (channelUserId: string) => ({
    channel: "web",
    channel_user_id: channelUserId,
    display_name: "Someone",
  })

  test("DATA-1: a row written by one agent is invisible to another", async () => {
    await restaurant.people.insert(newPerson("shared-1"))

    expect(await restaurant.people.find({ channel_user_id: "shared-1" })).not.toBeNull()
    expect(await dentist.people.find({ channel_user_id: "shared-1" })).toBeNull()
  })

  test("DATA-1: two agents can hold the same channel user without colliding", async () => {
    const mine = await restaurant.people.insert(newPerson("shared-2"))
    const theirs = await dentist.people.insert(newPerson("shared-2"))

    expect(mine.agent_id).toBe("restaurant")
    expect(theirs.agent_id).toBe("dentist")
    expect(mine.id).not.toBe(theirs.id)
  })

  test("DATA-1: an update reaches only the agent's own rows", async () => {
    await restaurant.people.insert(newPerson("shared-3"))
    await dentist.people.insert(newPerson("shared-3"))

    const changed = await restaurant.people.update(
      { channel_user_id: "shared-3" },
      { blocked: true },
    )
    expect(changed).toHaveLength(1)

    const theirs = await dentist.people.find({ channel_user_id: "shared-3" })
    expect(theirs?.blocked).toBe(false)
  })

  test("DATA-1: a delete reaches only the agent's own rows", async () => {
    await restaurant.people.insert(newPerson("shared-4"))
    await dentist.people.insert(newPerson("shared-4"))

    await restaurant.people.remove({ channel_user_id: "shared-4" })

    expect(await restaurant.people.find({ channel_user_id: "shared-4" })).toBeNull()
    expect(await dentist.people.find({ channel_user_id: "shared-4" })).not.toBeNull()
  })

  test("DATA-1: counting counts only the agent's own rows", async () => {
    await restaurant.people.insertMany([newPerson("count-1"), newPerson("count-2")])
    await dentist.people.insert(newPerson("count-3"))

    expect(await restaurant.people.count()).toBe(2)
    expect(await dentist.people.count()).toBe(1)
  })

  test("DATA-1: the agent is stamped on insert without the caller saying so", async () => {
    const person = await restaurant.people.insert(newPerson("stamp-1"))
    expect(person.agent_id).toBe("restaurant")
  })

  test("DATA-1: rows come back in the order asked for", async () => {
    await restaurant.people.insert(newPerson("order-a"))
    await restaurant.people.insert(newPerson("order-b"))

    const rows = await restaurant.people.list(
      {},
      { orderBy: "channel_user_id", ascending: false, limit: 2 },
    )
    expect(rows.map((row) => row.channel_user_id)).toEqual(["order-b", "order-a"])
  })

  // LEARN-3 needs a week of rows and the week before it, which equality
  // filters cannot express. `update` has had these comparisons since
  // DATA-4; reading was the half that could not use them, so a caller
  // wanting a date range had to read everything and filter in memory,
  // where a limit silently truncates the numbers a digest reports.
  test("DATA-1: a range reads one window of rows, not everything", async () => {
    for (const day of ["2026-10-01", "2026-10-08", "2026-10-15"]) {
      await restaurant.events.insert({
        name: "turn_started",
        props: {},
        created_at: `${day}T00:00:00Z`,
      })
    }

    const window = await restaurant.events.list(
      {},
      {
        range: {
          gte: { created_at: "2026-10-05T00:00:00Z" },
          lt: { created_at: "2026-10-12T00:00:00Z" },
        },
      },
    )

    expect(window).toHaveLength(1)
    expect(window[0]?.created_at.startsWith("2026-10-08")).toBe(true)
  })

  test("DATA-1: a range counts one window too, without reading the rows", async () => {
    for (const day of ["2026-10-01", "2026-10-08", "2026-10-09"]) {
      await restaurant.events.insert({
        name: "turn_started",
        props: {},
        created_at: `${day}T00:00:00Z`,
      })
    }

    const inWindow = await restaurant.events.count(
      {},
      { gte: { created_at: "2026-10-05T00:00:00Z" } },
    )

    expect(inWindow).toBe(2)
  })

  test("DATA-1: a range stays inside the agent, like every other read", async () => {
    await restaurant.events.insert({
      name: "turn_started",
      props: {},
      created_at: "2026-10-08T00:00:00Z",
    })
    await dentist.events.insert({
      name: "turn_started",
      props: {},
      created_at: "2026-10-08T00:00:00Z",
    })

    const mine = await dentist.events.list(
      {},
      { range: { gte: { created_at: "2026-10-01T00:00:00Z" } } },
    )

    expect(mine).toHaveLength(1)
  })

  test("DATA-1: the store reports a failed query rather than returning nothing", async () => {
    const broken = createStore(localSupabase("service_role"), "restaurant")
    let message = ""
    try {
      await broken.table("ob_people").list({ no_such_column: "x" })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("ob_people")
  })

  test("DATA-5: the anon key a frontend holds reaches no core row", async () => {
    await restaurant.people.insert(newPerson("private-1"))

    // Same query, same table, but the key a website would ship with.
    const asAnon = createStore(localSupabase("anon"), "restaurant")
    expect(await asAnon.people.list()).toEqual([])
    expect(await restaurant.people.list()).not.toEqual([])
  })
})
