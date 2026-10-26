// Artificial load on the local database, for Known K14 step 3.
//
// Two integration tests have stalled intermittently, only ever under the
// full run, and one of them took 13.6 seconds before it failed. Steps 1
// and 2 of K14 instrumented the failure and removed the leaked agent
// suspect. This is step 3: put the database under load on purpose, run the
// two suspect files on their own against it, and see which side slows.
//
//   bun run scripts/dbload.ts --clients 12 --seconds 180
//   # in another terminal, while that runs
//   bun test packages/core/test/integration/outbox.test.ts
//
// How to read it. The report is this script's own latency, not the suite's.
// If the suite stalls while these numbers climb, the database or the
// connection pool is the thing that cannot keep up. If the suite stalls
// while these stay flat, the stall is ours.
//
// It only reads, and only from tables the core owns, so it cannot change
// what a test sees. It loads Postgres directly rather than PostgREST,
// which is the part both of them sit on.
import { SQL } from "bun"

/** The same default as test/support/db.ts, for the stack `db:up` starts. */
const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

function flag(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = Number(process.argv[at + 1])
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} needs a positive number`)
  }
  return value
}

const clients = flag("clients", 8)
const seconds = flag("seconds", 60)
const url = process.env["DATABASE_URL"] ?? LOCAL

/** A read that touches what the worker and the outbox read every pass. */
const QUERIES = [
  "select id, status from ob_inbox order by seq desc limit 20",
  "select id, status, attempts from ob_outbox order by seq desc limit 20",
  "select person_id, owner, expires_at from ob_person_leases limit 20",
  "select id, kind, status from ob_jobs order by seq desc limit 20",
]

const latencies: number[] = []
let done = 0
let failed = 0
let stop = false

async function client(sql: SQL, at: number): Promise<void> {
  let next = at
  while (!stop) {
    const query = QUERIES[next % QUERIES.length] as string
    next++
    const started = performance.now()
    try {
      await sql.unsafe(query)
      latencies.push(performance.now() - started)
      done++
    } catch (error) {
      failed++
      if (failed < 4) console.error(`  query failed: ${(error as Error).message}`)
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const at = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
  return sorted[at] as number
}

const pool = new SQL({ url, max: clients })
try {
  await pool`select 1`
} catch (error) {
  console.error(`no database at ${url}: ${(error as Error).message}`)
  console.error("Start it with `bun run db:up`.")
  process.exit(1)
}

console.log(`loading ${url}`)
console.log(`${clients} client(s), ${seconds}s. Ctrl-C to stop early.\n`)

const onInterrupt = (): void => {
  stop = true
}
process.on("SIGINT", onInterrupt)

const workers = Array.from({ length: clients }, (_, at) => client(pool, at))

const report = setInterval(() => {
  const window = latencies.splice(0).sort((a, b) => a - b)
  const line = [
    `${done} queries`,
    `${window.length}/s`,
    `p50 ${percentile(window, 50).toFixed(1)}ms`,
    `p95 ${percentile(window, 95).toFixed(1)}ms`,
    `max ${(window[window.length - 1] ?? 0).toFixed(1)}ms`,
  ]
  if (failed > 0) line.push(`${failed} failed`)
  console.log(`  ${line.join("  ")}`)
}, 1000)

setTimeout(() => {
  stop = true
}, seconds * 1000)

await Promise.all(workers)
clearInterval(report)
process.off("SIGINT", onInterrupt)
await pool.close()

console.log(`\n${done} queries, ${failed} failed.`)
