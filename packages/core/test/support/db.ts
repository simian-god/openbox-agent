// Test support for the local Postgres that `bun run db:up` starts.
//
// Integration tests share one database, so each file resets it before it
// runs. Reset means truncate, not re-migrate: the schema is applied once and
// stays put, which keeps a file's setup to a few milliseconds.
//
// With no database running, `describeDatabase` skips its block, so the suite
// stays green on a machine without Docker.
import { SQL } from "bun"
import { describe, beforeAll, afterAll } from "bun:test"
import { createHmac } from "node:crypto"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { envOr } from "../../src/env.ts"

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

/**
 * Empties every table in the public schema, leaving the schema itself alone.
 * One TRUNCATE over all of them so foreign keys never order the work.
 */
export async function resetDatabase(sql: SQL): Promise<void> {
  const rows = (await sql`
    select tablename
    from pg_tables
    where schemaname = 'public'
    order by tablename
  `) as { tablename: string }[]

  if (rows.length === 0) return

  const names = rows.map((r) => `public.${quoteIdent(r.tablename)}`).join(", ")
  await sql.unsafe(`truncate table ${names} restart identity cascade`)
}

/**
 * Drops every table in the public schema, leaving the schema itself and
 * its grants alone.
 *
 * `drop schema public cascade` would be shorter, but it also destroys the
 * grants Supabase gives the anon, authenticated and service_role roles, so
 * the local database stops behaving like a real project. Tests that need a
 * bare schema use this instead.
 */
export async function dropAllTables(sql: SQL): Promise<void> {
  const rows = (await sql`
    select tablename from pg_tables where schemaname = 'public' order by tablename
  `) as { tablename: string }[]

  if (rows.length === 0) return

  const names = rows.map((row) => `public.${quoteIdent(row.tablename)}`).join(", ")
  await sql.unsafe(`drop table if exists ${names} cascade`)
}

/** Identifier quoting, so a table name can never be read as SQL. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

// Checked once per test file, when the file imports this module.
const available = await databaseAvailable()

/**
 * A describe block that needs the database. It is skipped when none is
 * running, and otherwise gets a clean database before its first test.
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
