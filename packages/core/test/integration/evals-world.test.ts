// TEST-2 and Spec section 23: the core under a client that is not Postgres.
//
// evals-agent runs a subject against an in memory SQLite world behind a
// supabase-js shim. Section 23 lists two things to check before anything
// relies on it, and T2.6 is where they get checked. What came back:
//
//   DATA-4's conditional claims work. The shim builds
//   `update ... where ... returning *`, applies every filter the core uses
//   (eq, lt, lte, gt, gte, neq, is, in), and hands the changed rows back.
//   Person leases, outbox claims and job claims are all safe there.
//
//   Error codes do not survive. Every database error comes back under one
//   code of the shim's own, so SQLSTATE 23505 is not there to read. A core
//   that knew only the number would treat every duplicate as a crash.
//
// That second one is what this file holds the line on. It runs the real
// duplicate paths against the real database, with the client's errors
// rewritten into the shape the shim reports, so the core cannot quietly go
// back to depending on a Postgres error code.
import { test, expect, beforeAll, beforeEach, afterEach } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { SupabaseClient } from "@supabase/supabase-js"
import { describeDatabase, localSupabase, resetDatabase } from "../support/db.ts"
import { code, tsFiles } from "../support/source.ts"
import { migrate } from "../../src/migrate/index.ts"
import {
  createAgent as buildAgent,
  type Agent,
  type AgentOptions,
  type Deps,
} from "../../src/runtime/index.ts"
import { defineConfig, type OpenboxConfig } from "../../src/config/index.ts"
import { isUniqueViolation, StoreError } from "../../src/store/index.ts"
import { scriptedBrain } from "../../src/testing/scripted-brain.ts"
import { fakeSender, type FakeSender } from "../../src/testing/fake-sender.ts"
import { systemClock } from "../../src/testing/clock.ts"

const PROMPT = "You are the host at a restaurant."
const started: Agent[] = []

function createAgent(options: AgentOptions): Agent {
  const agent = buildAgent(options)
  started.push(agent)
  return agent
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((agent) => agent.stop()))
})

function config(over: Record<string, unknown> = {}): OpenboxConfig {
  return defineConfig({
    name: "restaurant",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: [["11:00", "23:00"]] },
    brain: { id: "openrouter", model: "test/model" },
    decisionModel: { id: "jev" },
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages.",
    retentionDays: 365,
    burstWindowMs: 0,
    workerPollMs: 20,
    ...over,
  })
}

/**
 * The real client, with its errors rewritten the way evals-agent's shim
 * reports them: one code of its own, and the message SQLite would have
 * given rather than the one Postgres gives.
 */
function withShimErrors(real: SupabaseClient): SupabaseClient {
  const rewrite = (error: unknown): unknown => {
    if (error === null || typeof error !== "object") return error
    const got = error as { code?: unknown; message?: unknown }
    if (got.code !== "23505") return { code: "EVALS_DB", message: String(got.message ?? "") }
    // What bun:sqlite says in the same situation. No SQLSTATE anywhere.
    return { code: "EVALS_DB", message: "UNIQUE constraint failed: a_table.a_column" }
  }

  const wrap = (query: unknown): unknown =>
    new Proxy(query as object, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown

        if (key === "then") {
          return (onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
            (target as PromiseLike<{ data: unknown; error: unknown }>).then((out) => {
              const next = { ...out, error: rewrite(out.error) }
              return onOk ? onOk(next) : next
            }, onErr)
        }

        if (typeof value === "function") {
          return (...args: unknown[]) => {
            const next = (value as (...a: unknown[]) => unknown).apply(target, args)
            return next === target || (next !== null && typeof next === "object" && "then" in next)
              ? wrap(next)
              : next
          }
        }
        return value
      },
    })

  return { from: (name: string) => wrap(real.from(name)) } as unknown as SupabaseClient
}

test("TEST-2: the core calls no Postgres function, so there is no RPC to port", () => {
  // The other half of TEST-2, and the reason the shim can stand in at all:
  // DATA-4 forbids RPCs, so a world with no plpgsql has nothing to supply.
  // evals-agent answers an RPC it has no TS port for with an error, so one
  // creeping in would fail there and pass here.
  const src = join(import.meta.dir, "..", "..", "src")
  const offenders: string[] = []
  for (const file of tsFiles(src)) {
    const text = code(readFileSync(join(src, file), "utf8"))
    for (const match of text.matchAll(/\.rpc\s*\(/g)) {
      const line = text.slice(0, match.index).split(String.fromCharCode(10)).length
      offenders.push(`${file}:${line}`)
    }
  }
  expect(offenders).toEqual([])
})

test("the error shapes both engines produce are read as duplicates", () => {
  // Postgres, through supabase-js or Bun.sql.
  expect(isUniqueViolation({ code: "23505", message: "duplicate key value" })).toBe(true)
  // evals-agent's shim: no SQLSTATE, SQLite's words.
  expect(
    isUniqueViolation({
      code: "EVALS_DB",
      message: "UNIQUE constraint failed: ob_inbox.agent_id, ob_inbox.channel_message_id",
    }),
  ).toBe(true)
  // Wrapped by the store, either way round.
  expect(
    isUniqueViolation(
      new StoreError("ob_inbox", "insert", {
        code: "EVALS_DB",
        message: "UNIQUE constraint failed: x",
      }),
    ),
  ).toBe(true)
  expect(isUniqueViolation(new StoreError("ob_inbox", "insert", { code: "23505" }))).toBe(true)

  // And nothing else is mistaken for one.
  expect(isUniqueViolation({ code: "EVALS_DB", message: "no such table: ob_inbox" })).toBe(false)
  expect(isUniqueViolation({ code: "42P01", message: "relation does not exist" })).toBe(false)
  expect(isUniqueViolation(new Error("the database is on fire"))).toBe(false)
  expect(isUniqueViolation(null)).toBe(false)
  expect(isUniqueViolation("a string")).toBe(false)
})

describeDatabase("the core under a client with no SQLSTATE", (sql) => {
  let sender: FakeSender

  beforeAll(async () => {
    await migrate({ sql: sql() })
    await sql().unsafe("notify pgrst, 'reload schema'")
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  function agentWith(over: Record<string, unknown> = {}): Agent {
    sender = fakeSender()
    const deps: Deps = {
      brains: [scriptedBrain([{ reply: "We open at 11." }])],
      db: withShimErrors(localSupabase()),
      sender,
      clock: systemClock,
    }
    return createAgent({ config: config(over), deps, prompt: PROMPT, tools: [] })
  }

  const hello = (over: Record<string, unknown> = {}) => ({
    channel: "whatsapp",
    channelUserId: "42",
    channelMessageId: "msg-1",
    text: "Any space on Monday?",
    ...over,
  })

  test("LOOP-1: a webhook delivered twice is still dropped", async () => {
    const agent = agentWith()
    agent.start()

    const first = await agent.receiveAndWait(hello())
    const second = await agent.receiveAndWait(hello())

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(await agent.store.inbox.count()).toBe(1)
    expect(await agent.store.turns.count()).toBe(1)
    expect(sender.texts()).toEqual(["We open at 11."])
  })

  test("ROLE-1: two messages from one new person at once make one person", async () => {
    const agent = agentWith()
    agent.start()

    await Promise.all([
      agent.receive(hello({ channelMessageId: "a" })),
      agent.receive(hello({ channelMessageId: "b" })),
    ])
    await agent.settled()

    expect(await agent.store.people.count()).toBe(1)
  })

  test("SEND-1: the same reply queued twice is sent once", async () => {
    const agent = agentWith()
    agent.start()
    await agent.receiveAndWait(hello())

    const queued = (await agent.store.outbox.list())[0]
    const person = await agent.store.people.find({})
    await agent.outbox.queue({
      personId: person?.id ?? "",
      kind: "reply",
      channel: "whatsapp",
      channelUserId: "42",
      text: "We open at 11.",
      idempotencyKey: queued?.idempotency_key ?? "",
    })
    await agent.settled()

    expect(await agent.store.outbox.count()).toBe(1)
    expect(sender.sent).toHaveLength(1)
  })

  test("PRO-1: the same dedupe key twice queues one job", async () => {
    const agent = agentWith()

    const once = await agent.jobs.queue({ kind: "remind", dedupeKey: "booking-7" })
    const twice = await agent.jobs.queue({ kind: "remind", dedupeKey: "booking-7" })

    expect(twice.id).toBe(once.id)
    expect(await agent.store.jobs.count()).toBe(1)
  })

  test("LEARN-2: two processes starting at once write one version row", async () => {
    const first = agentWith()
    const second = agentWith()
    first.start()
    second.start()

    await Promise.all([
      first.receiveAndWait(hello({ channelUserId: "1", channelMessageId: "a" })),
      second.receiveAndWait(hello({ channelUserId: "2", channelMessageId: "b" })),
    ])

    expect(first.versionHash).toBe(second.versionHash)
    expect(await first.store.versions.count()).toBe(1)
  })

  test("DATA-4: a conditional claim still decides between two processes", async () => {
    // The shim builds the same `update ... where ... returning *`, so this
    // is the mechanism that has to keep working there.
    const first = agentWith()
    const firstSender = sender
    const second = agentWith()
    const secondSender = sender

    await first.receive(hello())
    first.start()
    second.start()
    await first.settled()
    await second.settled()

    expect(await first.store.turns.count()).toBe(1)
    // Either process may win the claim, so the count that matters is the
    // total. Asserting on one of them passes or fails by luck, which is
    // how this test was first written.
    expect(firstSender.sent.length + secondSender.sent.length).toBe(1)
  })
})
