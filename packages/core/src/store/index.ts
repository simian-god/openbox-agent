// DATA-1: every core table has agent_id, and every core query filters on
// it.
//
// That rule is kept honest by structure, not by discipline. `scoped` below
// is the only place in the core that calls `db.from(...)`, so there is no
// way to read or write a core table without the filter. A test enforces
// that single call site, the same way DEP-1 is enforced.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { CoreRows, CoreTable } from "./tables.ts"

export * from "./tables.ts"

/** Raised when the database refuses a query. */
export class StoreError extends Error {
  readonly table: string
  override readonly cause: unknown
  /** Postgres' SQLSTATE, when the database gave one. 23505 is a duplicate. */
  readonly code: string | undefined

  constructor(table: string, operation: string, cause: unknown) {
    const detail =
      cause !== null && typeof cause === "object" && "message" in cause
        ? String((cause as { message: unknown }).message)
        : String(cause)
    super(`${operation} on ${table} failed: ${detail}`)
    this.name = "StoreError"
    this.table = table
    this.cause = cause
    this.code =
      cause !== null &&
      typeof cause === "object" &&
      typeof (cause as { code?: unknown }).code === "string"
        ? (cause as { code: string }).code
        : undefined
  }
}

/** Postgres' code for a unique constraint violation. */
export const UNIQUE_VIOLATION = "23505"

/**
 * What a database says when a row already existed, in the words of the two
 * engines the core is ever run on.
 *
 * Postgres: `duplicate key value violates unique constraint "..."`.
 * SQLite:   `UNIQUE constraint failed: ob_inbox.agent_id, ...`.
 */
const UNIQUE_TEXT = /duplicate key value|unique constraint/i

/**
 * True when the database refused a write because the row already existed.
 *
 * This decides whether the core sees a duplicate or a failure, and a
 * surprising amount rests on it: dropping a webhook delivered twice
 * (LOOP-1), one reply per question (SEND-1), one reminder per dedupe key
 * (PRO-1), and two processes meeting the same new person.
 *
 * SQLSTATE 23505 is the answer when there is one. There is not always one:
 * evals-agent's SQLite world reports every database error under a single
 * code of its own, so a core that knew only the number would treat every
 * duplicate as a crash the moment it ran under the harness. So the words
 * are read too. Checked on the error and on whatever it wrapped, since
 * either may be the one carrying them.
 */
export function isUniqueViolation(error: unknown): boolean {
  const causes = [error, (error as { cause?: unknown } | null)?.cause]

  for (const at of causes) {
    if (at === null || at === undefined || typeof at !== "object") continue
    const carrier = at as { code?: unknown; message?: unknown; details?: unknown }
    if (carrier.code === UNIQUE_VIOLATION) return true
    if (UNIQUE_TEXT.test(`${String(carrier.message ?? "")} ${String(carrier.details ?? "")}`)) {
      return true
    }
  }
  return false
}

/** A plain equality filter, applied on top of the agent_id scope. */
export type Where = Record<string, string | number | boolean | null>

/**
 * DATA-4: the rest of the expected state a conditional claim needs, on top
 * of the equality filters in `Where`. One `UPDATE ... WHERE` through
 * supabase-js filters, which is how a lease, a job, an outbox row or a
 * pending action is taken without an RPC and without a race.
 */
export interface Compare {
  lt?: Record<string, string | number> | undefined
  lte?: Record<string, string | number> | undefined
  gt?: Record<string, string | number> | undefined
  gte?: Record<string, string | number> | undefined
  neq?: Record<string, string | number | boolean | null> | undefined
  is?: Record<string, boolean | null> | undefined
  /** Exactly these rows, which is how a batch is updated in one trip. */
  isIn?: Record<string, (string | number)[]> | undefined
}

/**
 * The narrowing methods every PostgREST query builder shares.
 *
 * Structural on purpose: a select, an update and a head count all return
 * different builder types, and this is the part of them `applyCompare`
 * touches. Naming the union of the three adds nothing a reader wants.
 */
interface Narrowing {
  lt(column: string, value: never): Narrowing
  lte(column: string, value: never): Narrowing
  gt(column: string, value: never): Narrowing
  gte(column: string, value: never): Narrowing
  neq(column: string, value: never): Narrowing
  is(column: string, value: never): Narrowing
  in(column: string, values: never): Narrowing
}

export interface TableStore<Row> {
  /** Rows matching `where`, always within this agent. */
  list(
    where?: Where,
    options?: {
      limit?: number
      orderBy?: string
      ascending?: boolean
      /** DATA-4's comparisons, for a window a `Where` cannot express. */
      range?: Compare | undefined
    },
  ): Promise<Row[]>
  /** The first matching row, or null. */
  find(where: Where): Promise<Row | null>
  byId(id: string): Promise<Row | null>
  insert(row: Record<string, unknown>): Promise<Row>
  insertMany(rows: Record<string, unknown>[]): Promise<Row[]>
  /**
   * Updates the rows matching `where`, and `compare` when it is given, and
   * returns what changed. With `compare` this is DATA-4's conditional
   * claim: an empty result means the expected state did not hold.
   */
  update(where: Where, patch: Record<string, unknown>, compare?: Compare): Promise<Row[]>
  remove(where: Where): Promise<void>
  count(where?: Where, range?: Compare): Promise<number>
}

export interface Store {
  /** The agent every query is scoped to. */
  readonly agentId: string
  people: TableStore<CoreRows["ob_people"]>
  leases: TableStore<CoreRows["ob_person_leases"]>
  versions: TableStore<CoreRows["ob_versions"]>
  turns: TableStore<CoreRows["ob_turns"]>
  inbox: TableStore<CoreRows["ob_inbox"]>
  messages: TableStore<CoreRows["ob_messages"]>
  outbox: TableStore<CoreRows["ob_outbox"]>
  jobs: TableStore<CoreRows["ob_jobs"]>
  events: TableStore<CoreRows["ob_events"]>
  toolRuns: TableStore<CoreRows["ob_tool_runs"]>
  decisions: TableStore<CoreRows["ob_decisions"]>
  flags: TableStore<CoreRows["ob_flags"]>
  pendingActions: TableStore<CoreRows["ob_pending_actions"]>
  tasks: TableStore<CoreRows["ob_tasks"]>
  facts: TableStore<CoreRows["ob_facts"]>
  handovers: TableStore<CoreRows["ob_handovers"]>
  knowledge: TableStore<CoreRows["ob_knowledge"]>
  /** LIMIT-3: one row per day, holding today's total. */
  spend: TableStore<CoreRows["ob_spend"]>
  /** For a table with no typed accessor yet. Still scoped. */
  table<T = Record<string, unknown>>(name: string): TableStore<T>
}

export function createStore(db: SupabaseClient, agentId: string): Store {
  if (agentId === "") throw new Error("createStore needs an agentId: every query filters on it")

  /**
   * The single call site. Everything the core reads or writes goes through
   * here, so the agent_id filter cannot be forgotten.
   */
  function scoped<Row>(name: string): TableStore<Row> {
    const applyWhere = <Q extends { eq(column: string, value: never): Q }>(
      query: Q,
      where: Where,
    ): Q => {
      let out = query
      for (const [column, value] of Object.entries(where)) {
        out = out.eq(column, value as never)
      }
      return out
    }

    const base = () => db.from(name)

    /**
     * DATA-4's comparisons, applied to any query.
     *
     * Shared between `update`, `list` and `count` so a read narrows a
     * range exactly as a conditional write does. It was inline in
     * `update` until LEARN-3 needed to read one week and the week before
     * it: without this a caller had to read everything and filter in
     * memory, where a `limit` quietly truncates whatever it is counting.
     */
    const applyCompare = <Q>(query: Q, compare?: Compare): Q => {
      let out = query as Narrowing
      for (const [column, value] of Object.entries(compare?.lt ?? {})) {
        out = out.lt(column, value as never)
      }
      for (const [column, value] of Object.entries(compare?.lte ?? {})) {
        out = out.lte(column, value as never)
      }
      for (const [column, value] of Object.entries(compare?.gt ?? {})) {
        out = out.gt(column, value as never)
      }
      for (const [column, value] of Object.entries(compare?.gte ?? {})) {
        out = out.gte(column, value as never)
      }
      for (const [column, value] of Object.entries(compare?.neq ?? {})) {
        out = out.neq(column, value as never)
      }
      for (const [column, value] of Object.entries(compare?.is ?? {})) {
        out = out.is(column, value as never)
      }
      for (const [column, values] of Object.entries(compare?.isIn ?? {})) {
        out = out.in(column, values as never)
      }
      return out as Q
    }

    return {
      async list(where = {}, options = {}) {
        let query = applyCompare(
          applyWhere(base().select("*").eq("agent_id", agentId), where),
          options.range,
        )
        if (options.orderBy !== undefined) {
          query = query.order(options.orderBy, { ascending: options.ascending ?? true })
        }
        if (options.limit !== undefined) query = query.limit(options.limit)

        const { data, error } = await query
        if (error) throw new StoreError(name, "list", error)
        return (data ?? []) as Row[]
      },

      async find(where) {
        const rows = await this.list(where, { limit: 1 })
        return rows[0] ?? null
      },

      async byId(id) {
        return this.find({ id })
      },

      async insert(row) {
        const rows = await this.insertMany([row])
        const inserted = rows[0]
        if (inserted === undefined) throw new StoreError(name, "insert", "no row returned")
        return inserted
      },

      async insertMany(rows) {
        if (rows.length === 0) return []
        // agent_id is stamped here, so a caller cannot write to another agent.
        const stamped = rows.map((row) => ({ ...row, agent_id: agentId }))
        const { data, error } = await base().insert(stamped).select()
        if (error) throw new StoreError(name, "insert", error)
        return (data ?? []) as Row[]
      },

      async update(where, patch, compare) {
        // agent_id is never patchable: a row cannot be moved between agents.
        const { agent_id: _ignored, ...safe } = patch
        let query = applyWhere(base().update(safe).eq("agent_id", agentId), where)

        // DATA-4: the rest of the expected state. Postgres takes a row lock
        // for the update, so of several callers reaching for the same row
        // exactly one gets it back and the others get nothing.
        for (const [column, value] of Object.entries(compare?.lt ?? {})) {
          query = query.lt(column, value as never)
        }
        for (const [column, value] of Object.entries(compare?.lte ?? {})) {
          query = query.lte(column, value as never)
        }
        for (const [column, value] of Object.entries(compare?.gt ?? {})) {
          query = query.gt(column, value as never)
        }
        for (const [column, value] of Object.entries(compare?.gte ?? {})) {
          query = query.gte(column, value as never)
        }
        for (const [column, value] of Object.entries(compare?.neq ?? {})) {
          query = query.neq(column, value as never)
        }
        for (const [column, value] of Object.entries(compare?.is ?? {})) {
          query = query.is(column, value as never)
        }
        for (const [column, values] of Object.entries(compare?.isIn ?? {})) {
          query = query.in(column, values as never)
        }

        const { data, error } = await query.select()
        if (error) throw new StoreError(name, "update", error)
        return (data ?? []) as Row[]
      },

      async remove(where) {
        const query = applyWhere(base().delete().eq("agent_id", agentId), where)
        const { error } = await query
        if (error) throw new StoreError(name, "delete", error)
      },

      async count(where = {}, range) {
        const query = applyCompare(
          applyWhere(
            base().select("*", { count: "exact", head: true }).eq("agent_id", agentId),
            where,
          ),
          range,
        )
        const { count, error } = await query
        if (error) throw new StoreError(name, "count", error)
        return count ?? 0
      },
    }
  }

  const forTable = <T extends CoreTable>(name: T) => scoped<CoreRows[T]>(name)

  return {
    agentId,
    people: forTable("ob_people"),
    leases: forTable("ob_person_leases"),
    versions: forTable("ob_versions"),
    turns: forTable("ob_turns"),
    inbox: forTable("ob_inbox"),
    messages: forTable("ob_messages"),
    outbox: forTable("ob_outbox"),
    jobs: forTable("ob_jobs"),
    events: forTable("ob_events"),
    toolRuns: forTable("ob_tool_runs"),
    decisions: forTable("ob_decisions"),
    flags: forTable("ob_flags"),
    pendingActions: forTable("ob_pending_actions"),
    tasks: forTable("ob_tasks"),
    facts: forTable("ob_facts"),
    handovers: forTable("ob_handovers"),
    knowledge: forTable("ob_knowledge"),
    spend: forTable("ob_spend"),
    table: <T = Record<string, unknown>>(name: string) => scoped<T>(name),
  }
}
