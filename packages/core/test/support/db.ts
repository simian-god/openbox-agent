// Test support for the local Postgres that `bun run db:up` starts.
//
// Integration tests share one database and Bun runs them all in one process,
// so the schema is applied once for the whole run, not once per file. Each
// file then resets it before it runs. Reset means truncate, not re-migrate,
// which keeps a file's setup to a few milliseconds.
//
// With no database running, `describeDatabase` skips its block, so the suite
// stays green on a machine without Docker.
import { SQL } from "bun"
import { describe, beforeAll, afterAll } from "bun:test"
import { createHmac } from "node:crypto"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { envOr } from "../../src/env.ts"
import { migrate } from "../../src/migrate/index.ts"

/** What `supabase start` serves. Matches [db].port in supabase/config.toml. */
export const LOCAL_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

/** DATABASE_URL wins, so CI and a hosted database need no code change. */
export function databaseUrl(): string {
  return envOr("DATABASE_URL", LOCAL_DATABASE_URL)
}

/** Opens a connection, or returns null if nothing is listening. */
export async function tryConnect(url: string = databaseUrl()): Promise<SQL | null> {
  const sql = new SQL({ url, max: 2, connectionTimeout: 3 })
  try {
    await sql`select 1`
    return sql
  } catch {
    await sql.close().catch(() => {})
    return null
  }
}

export async function databaseAvailable(url: string = databaseUrl()): Promise<boolean> {
  const sql = await tryConnect(url)
  if (!sql) return false
  await sql.close()
  return true
}

/** The names of every table in the public schema. */
async function tablesIn(sql: SQL): Promise<string[]> {
  const rows = (await sql`
    select tablename from pg_tables where schemaname = 'public' order by tablename
  `) as { tablename: string }[]
  return rows.map((row) => row.tablename)
}

/**
 * Empties every table in the public schema, leaving the schema itself alone.
 * One TRUNCATE over all of them so foreign keys never order the work.
 *
 * `ob_migrations` is skipped on purpose. It records which migrations have
 * already run, so emptying it told the next caller that none had, and every
 * migration was applied again from scratch.
 */
export async function resetDatabase(sql: SQL): Promise<void> {
  const names = (await tablesIn(sql))
    .filter((name) => name !== "ob_migrations")
    .map((name) => `public.${quoteIdent(name)}`)

  if (names.length === 0) return

  await sql.unsafe(`truncate table ${names.join(", ")} restart identity cascade`)
}

/**
 * The schema, applied once for the whole test process.
 *
 * Every integration file needs the tables to exist, but building them is
 * per-process work, not per-file work: one process, one database. Doing it
 * per file re-applied all the migrations and then slept a flat 1.5 seconds
 * waiting for PostgREST, thirty times over.
 */
let schema: Promise<void> | undefined

export function ensureSchema(sql: SQL): Promise<void> {
  // A failure is forgotten, so the next file tries again and sees the real
  // error rather than inheriting a rejected promise from another file.
  schema ??= applySchema(sql).catch((error: unknown) => {
    schema = undefined
    throw error
  })
  return schema
}

async function applySchema(sql: SQL): Promise<void> {
  // migrate ends by telling PostgREST to reload, so there is nothing to
  // notify here. What is left is knowing when the reload has landed.
  await migrate({ sql })
  await waitForRest(await tablesIn(sql))
}

/**
 * Waits until PostgREST serves every table, rather than sleeping and hoping.
 *
 * PostgREST caches the schema and reloads when told, so a table it has not
 * heard about yet is a PGRST205 rather than a row. Measured against the
 * local stack, the reload lands about 10ms after the notice, and within
 * about 400ms even without one. The flat 1.5 second sleep this replaces was
 * roughly a hundred times longer than the window it was covering.
 */
export async function waitForRest(tables: string[], withinMs = 30_000): Promise<void> {
  const client = localSupabase()
  const deadline = Date.now() + withinMs
  let missing = tables

  for (;;) {
    const checked = await Promise.all(
      missing.map(async (table) => {
        // A body, not a HEAD. PostgREST answers a HEAD for a table it does
        // not have without an error at all, so a head check proves nothing.
        const { error } = await client.from(table).select("*").limit(1)
        return error === null ? null : table
      }),
    )

    missing = checked.filter((name): name is string => name !== null)
    if (missing.length === 0) return

    if (Date.now() > deadline) {
      throw new Error(`PostgREST never served these tables: ${missing.join(", ")}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Drops every table in the public schema, leaving the schema itself and
 * its grants alone.
 *
 * `drop schema public cascade` would be shorter, but it also destroys the
 * grants Supabase gives the anon, authenticated and service_role roles, so
 * the local database stops behaving like a real project. Tests that need a
 * bare schema use this instead.
 *
 * It also forgets the applied schema, because after this the tables another
 * file is counting on are gone and have to be built again.
 */
export async function dropAllTables(sql: SQL): Promise<void> {
  schema = undefined

  const names = (await tablesIn(sql)).map((name) => `public.${quoteIdent(name)}`)
  if (names.length === 0) return

  await sql.unsafe(`drop table if exists ${names.join(", ")} cascade`)
}

/** Identifier quoting, so a table name can never be read as SQL. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

// Checked once per test file, when the file imports this module.
const available = await databaseAvailable()

/**
 * A describe block that needs the database. It is skipped when none is
 * running, and otherwise gets the schema and a clean database before its
 * first test.
 *
 *   describeDatabase("ob_people", (sql) => {
 *     test("...", async () => { await sql().query(...) })
 *   })
 */
export function describeDatabase(name: string, build: (sql: () => SQL) => void): void {
  describe.skipIf(!available)(name, () => {
    let connection: SQL | null = null

    beforeAll(async () => {
      connection = await tryConnect()
      if (!connection) throw new Error(`no database at ${databaseUrl()}`)
      await ensureSchema(connection)
      await resetDatabase(connection)
    })

    afterAll(async () => {
      await connection?.close()
      connection = null
    })

    build(() => {
      if (!connection) throw new Error("the database is only open inside a test")
      return connection
    })
  })
}

/** True when a database was reachable as this file loaded. */
export function databaseIsRunning(): boolean {
  return available
}

/** What `supabase start` serves the REST API on. */
export const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321"

/**
 * The JWT secret every local Supabase stack uses. It is published in
 * Supabase's own documentation and only ever signs tokens for a database
 * on this machine, so it is not a secret in any useful sense. A real
 * project's key always comes from the environment.
 */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long"

/** Mints a local API key for one Postgres role. */
export function localApiKey(role: "service_role" | "anon"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    role,
    iss: "supabase-demo",
    iat: 1600000000,
    exp: 2900000000,
  })}`
  const signature = createHmac("sha256", LOCAL_JWT_SECRET).update(body).digest("base64url")
  return `${body}.${signature}`
}

/**
 * A supabase-js client for the local stack. The service role key bypasses
 * RLS, which is what an agent runs with; the anon key is what a frontend
 * would hold, and should reach nothing (DATA-5).
 */
export function localSupabase(role: "service_role" | "anon" = "service_role"): SupabaseClient {
  const url = envOr("SUPABASE_URL", LOCAL_SUPABASE_URL)
  const key =
    role === "service_role"
      ? envOr("SUPABASE_SERVICE_ROLE_KEY", localApiKey("service_role"))
      : localApiKey("anon")

  return createClient(url, key, { auth: { persistSession: false } })
}
