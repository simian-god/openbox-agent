// PKG-4: `openbox migrate` applies the core's migrations, then the agent's,
// in order.
//
// This runs plain DDL over DATABASE_URL with Bun's Postgres client, because
// supabase-js cannot issue DDL. It is a build time tool, not the runtime, so
// it sits outside the injected providers rule (DEP-1): the running agent
// still reaches the database only through the injected supabase-js client.
import { SQL } from "bun"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"

/** Where the core's own migrations live inside the package. */
export const CORE_MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations")

/**
 * DATA-3: the pgvector table's own migration, applied only when asked.
 *
 * A subdirectory of the core's, which `readMigrations` ignores because it
 * only reads `.sql` files in the one directory it is given. So the core's
 * own run cannot pick this up by accident.
 */
export const PGVECTOR_MIGRATIONS_DIR = join(CORE_MIGRATIONS_DIR, "pgvector")

export interface Migration {
  /** Unique and sortable, like `core/0001_core.sql`. */
  name: string
  sql: string
}

export interface MigrateOptions {
  /** Opens its own connection and closes it when done. */
  databaseUrl?: string | undefined
  /** An open connection to use instead. It is left open for the caller. */
  sql?: SQL | undefined
  /** The agent's own migrations, applied after the core's (PKG-4). */
  agentMigrationsDir?: string | undefined
  /** Overrides the core's directory. Tests use it; agents do not. */
  coreMigrationsDir?: string | undefined
  /**
   * DATA-3: also apply the pgvector table, for an agent whose config names
   * the pgvector retriever. Off by default, so no agent installs an
   * extension it does not use.
   */
  pgvector?: boolean | undefined
  log?: ((line: string) => void) | undefined
}

export interface MigrateResult {
  applied: string[]
  skipped: string[]
  /** Every table checked for RLS (DATA-6). */
  tablesChecked: number
}

/** Raised when migrations cannot be applied, or the schema is left unsafe. */
export class MigrateError extends Error {
  readonly problems: string[]

  constructor(message: string, problems: string[] = []) {
    // A blank entry is a spacer between the names and the advice, so it
    // must not get a bullet of its own.
    const list = problems.map((problem) => (problem === "" ? "" : `  - ${problem}`)).join("\n")
    super(problems.length > 0 ? `${message}\n${list}` : message)
    this.name = "MigrateError"
    this.problems = problems
  }
}

const checksum = (sql: string): string => createHash("sha256").update(sql).digest("hex")

/** Reads a directory of .sql files in filename order. */
export function readMigrations(dir: string, prefix: string): Migration[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []

  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({
      name: `${prefix}/${file}`,
      sql: readFileSync(join(dir, file), "utf8"),
    }))
}

/** The migrations that would run, core first, then the agent's (PKG-4). */
export function collectMigrations(options: MigrateOptions): Migration[] {
  return [
    ...readMigrations(options.coreMigrationsDir ?? CORE_MIGRATIONS_DIR, "core"),
    // Between the two, because it belongs to the core and an agent's own
    // migration may want to reference the table.
    ...(options.pgvector === true ? readMigrations(PGVECTOR_MIGRATIONS_DIR, "pgvector") : []),
    ...(options.agentMigrationsDir ? readMigrations(options.agentMigrationsDir, "agent") : []),
  ]
}

/**
 * DATA-6: every table in the schema must have RLS switched on. Returns the
 * names of any that do not.
 */
export async function tablesWithoutRls(sql: SQL): Promise<string[]> {
  const rows = (await sql`
    select tablename
    from pg_tables
    where schemaname = 'public' and rowsecurity = false
    order by tablename
  `) as { tablename: string }[]

  return rows.map((row) => row.tablename)
}

async function countTables(sql: SQL): Promise<number> {
  const rows = (await sql`
    select count(*)::int as n from pg_tables where schemaname = 'public'
  `) as { n: number }[]
  return rows[0]?.n ?? 0
}

/** The bookkeeping table, created before anything can be recorded. */
async function ensureMigrationsTable(sql: SQL): Promise<void> {
  await sql.unsafe(`
    create table if not exists ob_migrations (
      name       text primary key,
      checksum   text        not null,
      applied_at timestamptz not null default now()
    );
    alter table ob_migrations enable row level security;
  `)
}

/**
 * Applies every migration that has not run yet, then refuses to finish if
 * any table was left without RLS (DATA-6).
 *
 * Re-running is safe: a migration already recorded is skipped. A migration
 * whose contents changed since it ran is an error, because the database and
 * the file no longer agree.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => {})
  const migrations = collectMigrations(options)

  if (options.sql === undefined && options.databaseUrl === undefined) {
    throw new MigrateError("migrate needs either a databaseUrl or an open sql connection")
  }

  // A caller's connection is borrowed, never closed. Only a connection this
  // function opened is its to close.
  const borrowed = options.sql !== undefined
  const sql = options.sql ?? new SQL({ url: options.databaseUrl as string, max: 1 })

  const applied: string[] = []
  const skipped: string[] = []

  try {
    await ensureMigrationsTable(sql)

    const recorded = new Map(
      ((await sql`select name, checksum from ob_migrations`) as Migration_[]).map((row) => [
        row.name,
        row.checksum,
      ]),
    )

    for (const migration of migrations) {
      const sum = checksum(migration.sql)
      const already = recorded.get(migration.name)

      if (already !== undefined) {
        if (already !== sum) {
          throw new MigrateError(
            `The migration ${migration.name} has changed since it was applied.`,
            [
              "A migration that has already run must never be edited.",
              "Add a new migration that makes the change instead.",
            ],
          )
        }
        skipped.push(migration.name)
        continue
      }

      // One transaction per migration, so a failure leaves nothing half done.
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.sql)
        await tx`
          insert into ob_migrations (name, checksum) values (${migration.name}, ${sum})
        `
      })

      applied.push(migration.name)
      log(`applied ${migration.name}`)
    }

    // DATA-6, checked after everything has run, over the agent's tables too.
    const unsafe = await tablesWithoutRls(sql)
    if (unsafe.length > 0) {
      throw new MigrateError("These tables have row level security switched off (DATA-5):", [
        ...unsafe,
        "",
        "Add `alter table <name> enable row level security;` to the migration that creates it.",
        "If that migration has already run, add a new migration that does it.",
        "Without it, anyone holding the project's public anon key can read and write the table.",
      ])
    }

    const tablesChecked = await countTables(sql)

    // So PostgREST sees new tables at once rather than after a restart.
    await sql.unsafe(`notify pgrst, 'reload schema'`)

    return { applied, skipped, tablesChecked }
  } finally {
    if (!borrowed) await sql.close()
  }
}

type Migration_ = { name: string; checksum: string }
