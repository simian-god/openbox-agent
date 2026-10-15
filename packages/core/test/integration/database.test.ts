// The local stack and the per file reset helper.
//
// Every block here is skipped when no database is running, so the suite
// passes on a machine without Docker.
import { test, expect } from "bun:test"
import {
  databaseAvailable,
  describeDatabase,
  resetDatabase,
  databaseUrl,
  LOCAL_DATABASE_URL,
} from "../support/db.ts"

test("db helper: DATABASE_URL overrides the local stack", () => {
  const before = process.env["DATABASE_URL"]
  try {
    delete process.env["DATABASE_URL"]
    expect(databaseUrl()).toBe(LOCAL_DATABASE_URL)

    process.env["DATABASE_URL"] = "postgresql://elsewhere:5432/db"
    expect(databaseUrl()).toBe("postgresql://elsewhere:5432/db")
  } finally {
    if (before === undefined) delete process.env["DATABASE_URL"]
    else process.env["DATABASE_URL"] = before
  }
})

test("db helper: an unreachable database is reported, not thrown", async () => {
  // Port 1 is reserved and never serves Postgres.
  expect(await databaseAvailable("postgresql://postgres:postgres@127.0.0.1:1/postgres")).toBe(false)
})

describeDatabase("the local stack", (sql) => {
  test("db helper: the stack serves Postgres", async () => {
    const rows = await sql()`select current_database() as name`
    expect(rows[0].name).toBe("postgres")
  })

  test("db helper: reset empties every table but keeps the schema", async () => {
    await sql().unsafe("create table if not exists reset_probe (id serial primary key, v text)")
    await sql()`insert into reset_probe (v) values ('before')`
    expect((await sql()`select count(*)::int as n from reset_probe`)[0].n).toBe(1)

    await resetDatabase(sql())

    const after = await sql()`select count(*)::int as n from reset_probe`
    expect(after[0].n).toBe(0)
    await sql().unsafe("drop table reset_probe")
  })

  test("db helper: reset on an empty schema does nothing and does not fail", async () => {
    await resetDatabase(sql())
    const rows = await sql()`select count(*)::int as n from pg_tables where schemaname = 'public'`
    expect(rows[0].n).toBeGreaterThanOrEqual(0)
  })

  // Vacuous until the first migration lands in T1.3, then it guards the rule.
  test("DATA-3: the schema uses plain DDL, with no triggers, functions or extensions", async () => {
    const triggers = await sql()`
      select trigger_name from information_schema.triggers
      where trigger_schema = 'public'
    `
    expect(triggers.map((r: { trigger_name: string }) => r.trigger_name)).toEqual([])

    const routines = await sql()`
      select routine_name from information_schema.routines
      where routine_schema = 'public'
    `
    expect(routines.map((r: { routine_name: string }) => r.routine_name)).toEqual([])

    // pgvector is allowed, but only through its own optional migration.
    const extensions = await sql()`
      select extname from pg_extension
      where extnamespace = 'public'::regnamespace and extname <> 'vector'
    `
    expect(extensions.map((r: { extname: string }) => r.extname)).toEqual([])
  })
})
