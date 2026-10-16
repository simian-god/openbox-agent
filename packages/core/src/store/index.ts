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

  constructor(table: string, operation: string, cause: unknown) {
    const detail =
      cause !== null && typeof cause === "object" && "message" in cause
        ? String((cause as { message: unknown }).message)
        : String(cause)
    super(`${operation} on ${table} failed: ${detail}`)
    this.name = "StoreError"
    this.table = table
    this.cause = cause
  }
}

/** A plain equality filter, applied on top of the agent_id scope. */
export type Where = Record<string, string | number | boolean | null>

export interface TableStore<Row> {
  /** Rows matching `where`, always within this agent. */
  list(
    where?: Where,
    options?: { limit?: number; orderBy?: string; ascending?: boolean },
  ): Promise<Row[]>
  /** The first matching row, or null. */
  find(where: Where): Promise<Row | null>
  byId(id: string): Promise<Row | null>
  insert(row: Record<string, unknown>): Promise<Row>
  insertMany(rows: Record<string, unknown>[]): Promise<Row[]>
  update(where: Where, patch: Record<string, unknown>): Promise<Row[]>
  remove(where: Where): Promise<void>
  count(where?: Where): Promise<number>
}

export interface Store {
  /** The agent every query is scoped to. */
  readonly agentId: string
  people: TableStore<CoreRows["ob_people"]>
  versions: TableStore<CoreRows["ob_versions"]>
  turns: TableStore<CoreRows["ob_turns"]>
  inbox: TableStore<CoreRows["ob_inbox"]>
  messages: TableStore<CoreRows["ob_messages"]>
  events: TableStore<CoreRows["ob_events"]>
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

    return {
      async list(where = {}, options = {}) {
        let query = applyWhere(base().select("*").eq("agent_id", agentId), where)
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

      async update(where, patch) {
        // agent_id is never patchable: a row cannot be moved between agents.
        const { agent_id: _ignored, ...safe } = patch
        const query = applyWhere(base().update(safe).eq("agent_id", agentId), where)

        const { data, error } = await query.select()
        if (error) throw new StoreError(name, "update", error)
        return (data ?? []) as Row[]
      },

      async remove(where) {
        const query = applyWhere(base().delete().eq("agent_id", agentId), where)
        const { error } = await query
        if (error) throw new StoreError(name, "delete", error)
      },

      async count(where = {}) {
        const query = applyWhere(
          base().select("*", { count: "exact", head: true }).eq("agent_id", agentId),
          where,
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
    versions: forTable("ob_versions"),
    turns: forTable("ob_turns"),
    inbox: forTable("ob_inbox"),
    messages: forTable("ob_messages"),
    events: forTable("ob_events"),
    table: <T = Record<string, unknown>>(name: string) => scoped<T>(name),
  }
}
