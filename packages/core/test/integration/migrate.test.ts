// The core migrations and `openbox migrate`, against a real Postgres.
// Skipped when no database is running.
import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SQL } from "bun"
import { describeDatabase, dropAllTables } from "../support/db.ts"
import { failure } from "../support/throws.ts"
import {
  migrate,
  collectMigrations,
  tablesWithoutRls,
  MigrateError,
  CORE_MIGRATIONS_DIR,
} from "../../src/migrate/index.ts"

/** The six tables T1.3 creates, plus the bookkeeping one. */
const CORE_TABLES = ["ob_events", "ob_inbox", "ob_messages", "ob_people", "ob_turns", "ob_versions"]

/** A throwaway directory holding one .sql file. */
function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "openbox-migrations-"))
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
  return dir
}

/** Drops every table, so each test starts from a bare schema. */
async function emptySchema(sql: SQL): Promise<void> {
  await dropAllTables(sql)
}

const tableNames = async (sql: SQL): Promise<string[]> => {
  const rows = (await sql`
    select tablename from pg_tables where schemaname = 'public' order by tablename
  `) as { tablename: string }[]
  return rows.map((row) => row.tablename)
}

const columnsOf = async (sql: SQL, table: string): Promise<string[]> => {
  const rows = (await sql`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by column_name
  `) as { column_name: string }[]
  return rows.map((row) => row.column_name)
}

describeDatabase("migrations", (sql) => {
  test("PKG-4: the core's migrations ship inside the package and run in order", () => {
    const names = collectMigrations({}).map((m) => m.name)

    expect(names.length).toBeGreaterThan(0)
    expect(names[0]).toBe("core/0001_core.sql")
    expect([...names].sort()).toEqual(names)
  })

  test("PKG-4: the agent's migrations run after the core's", () => {
    const dir = migrationsDir({ "0001_menu.sql": "select 1;" })
    try {
      const names = collectMigrations({ agentMigrationsDir: dir }).map((m) => m.name)

      expect(names).toEqual(["core/0001_core.sql", "agent/0001_menu.sql"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("DATA-2: migrating creates the core tables", async () => {
    await emptySchema(sql())
    const result = await migrate({ sql: sql() })

    expect(result.applied).toContain("core/0001_core.sql")
    const tables = await tableNames(sql())
    for (const table of CORE_TABLES) expect(tables).toContain(table)
  })

  test("DATA-1: every core table has agent_id", async () => {
    await emptySchema(sql())
    await migrate({ sql: sql() })

    for (const table of CORE_TABLES) {
      expect(await columnsOf(sql(), table)).toContain("agent_id")
    }
  })

  test("DATA-1: the one table without agent_id is schema bookkeeping, not agent data", async () => {
    await emptySchema(sql())
    await migrate({ sql: sql() })

    const withoutAgentId: string[] = []
    for (const table of await tableNames(sql())) {
      if (!(await columnsOf(sql(), table)).includes("agent_id")) withoutAgentId.push(table)
    }
    expect(withoutAgentId).toEqual(["ob_migrations"])
  })

  test("DATA-5: every table has row level security switched on", async () => {
    await emptySchema(sql())
    await migrate({ sql: sql() })

    expect(await tablesWithoutRls(sql())).toEqual([])
  })

  test("DATA-5: core tables carry no policies, so only the service key reaches them", async () => {
    await emptySchema(sql())
    await migrate({ sql: sql() })

    const policies = (await sql()`
      select tablename, policyname from pg_policies where schemaname = 'public'
    `) as { tablename: string }[]
    expect(policies).toEqual([])
  })

  test("DATA-6: migrate fails and names the table when RLS is left off", async () => {
    await emptySchema(sql())
    const dir = migrationsDir({
      "0001_menu.sql": "create table menu_items (id serial primary key, name text);",
    })

    try {
      const failure = migrate({ sql: sql(), agentMigrationsDir: dir })
      await expect(failure).rejects.toThrow(MigrateError)

      let problems: string[] = []
      try {
        await migrate({ sql: sql(), agentMigrationsDir: dir })
      } catch (error) {
        problems = (error as MigrateError).problems
      }
      expect(problems).toContain("menu_items")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("DATA-6: an agent table with RLS on is accepted", async () => {
    await emptySchema(sql())
    const dir = migrationsDir({
      "0001_menu.sql": [
        "create table menu_items (id serial primary key, name text);",
        "alter table menu_items enable row level security;",
      ].join("\n"),
    })

    try {
      const result = await migrate({ sql: sql(), agentMigrationsDir: dir })
      expect(result.applied).toContain("agent/0001_menu.sql")
      expect(await tablesWithoutRls(sql())).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("DATA-3: the schema uses plain DDL, with no triggers, functions or extensions", async () => {
    await emptySchema(sql())
    await migrate({ sql: sql() })

    const triggers = (await sql()`
      select trigger_name from information_schema.triggers where trigger_schema = 'public'
    `) as { trigger_name: string }[]
    expect(triggers).toEqual([])

    const routines = (await sql()`
      select routine_name from information_schema.routines where routine_schema = 'public'
    `) as { routine_name: string }[]
    expect(routines).toEqual([])

    const extensions = (await sql()`
      select extname from pg_extension
      where extnamespace = 'public'::regnamespace and extname <> 'vector'
    `) as { extname: string }[]
    expect(extensions).toEqual([])
  })

  test("PKG-4: running migrate twice applies nothing the second time", async () => {
    await emptySchema(sql())
    const first = await migrate({ sql: sql() })
    const second = await migrate({ sql: sql() })

    expect(first.applied).toContain("core/0001_core.sql")
    expect(second.applied).toEqual([])
    expect(second.skipped).toContain("core/0001_core.sql")
  })

  test("PKG-4: editing a migration that already ran is an error", async () => {
    await emptySchema(sql())
    const dir = migrationsDir({
      "0001_menu.sql": [
        "create table menu_items (id serial primary key);",
        "alter table menu_items enable row level security;",
      ].join("\n"),
    })

    try {
      await migrate({ sql: sql(), agentMigrationsDir: dir })

      writeFileSync(
        join(dir, "0001_menu.sql"),
        [
          "create table menu_items (id serial primary key, name text);",
          "alter table menu_items enable row level security;",
        ].join("\n"),
      )

      const failure = migrate({ sql: sql(), agentMigrationsDir: dir })
      await expect(failure).rejects.toThrow(/has changed since it was applied/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("PKG-4: a failing migration leaves nothing behind", async () => {
    await emptySchema(sql())
    const dir = migrationsDir({
      "0001_broken.sql": [
        "create table good_one (id serial primary key);",
        "alter table good_one enable row level security;",
        "create table bad_one (id serial primary key, oops);",
      ].join("\n"),
    })

    try {
      await expect(migrate({ sql: sql(), agentMigrationsDir: dir })).rejects.toThrow()

      const tables = await tableNames(sql())
      expect(tables).not.toContain("good_one")
      expect(tables).not.toContain("bad_one")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("DATA-2: a person is unique per agent, channel and channel user id", async () => {
    await emptySchema(sql())
    await migrate({ sql: sql() })

    await sql()`
      insert into ob_people (agent_id, channel, channel_user_id)
      values ('demo', 'telegram', '42')
    `
    const duplicate = await failure(
      () => sql()`
        insert into ob_people (agent_id, channel, channel_user_id)
        values ('demo', 'telegram', '42')
      `,
    )
    expect(duplicate.message).toContain("ob_people_agent_id_channel_channel_user_id_key")

    // The same channel user id under a different agent is a different person.
    await sql()`
      insert into ob_people (agent_id, channel, channel_user_id)
      values ('other', 'telegram', '42')
    `
    const rows = (await sql()`select count(*)::int as n from ob_people`) as { n: number }[]
    expect(rows[0]?.n).toBe(2)
  })

  // ROLE-1 also needs a message to create the person, which arrives in T1.6.
  test("DATA-2: a new person is an end user, and only a known role is allowed", async () => {
    await emptySchema(sql())
    await migrate({ sql: sql() })

    await sql()`
      insert into ob_people (agent_id, channel, channel_user_id)
      values ('demo', 'web', 'a')
    `
    const rows = (await sql()`select role from ob_people`) as { role: string }[]
    expect(rows[0]?.role).toBe("end_user")

    const badRole = await failure(
      () => sql()`
        insert into ob_people (agent_id, channel, channel_user_id, role)
        values ('demo', 'web', 'b', 'admin')
      `,
    )
    expect(badRole.message).toContain("ob_people_role_check")
  })

  test("DATA-2: the same channel message id cannot arrive twice for one person", async () => {
    await emptySchema(sql())
    await migrate({ sql: sql() })

    const people = (await sql()`
      insert into ob_people (agent_id, channel, channel_user_id)
      values ('demo', 'web', 'a') returning id
    `) as { id: string }[]
    const personId = people[0]?.id

    await sql()`
      insert into ob_inbox (agent_id, person_id, channel_message_id, text)
      values ('demo', ${personId}, 'msg-1', 'hello')
    `
    const duplicate = await failure(
      () => sql()`
        insert into ob_inbox (agent_id, person_id, channel_message_id, text)
        values ('demo', ${personId}, 'msg-1', 'hello')
      `,
    )
    expect(duplicate.message).toContain("ob_inbox_agent_id_person_id_channel_message_id_key")
  })

  test("PKG-4: the core migrations directory is inside the published package", () => {
    expect(CORE_MIGRATIONS_DIR).toContain("migrations")
    expect(collectMigrations({})[0]?.sql).toContain("ob_people")
  })
})
