// What an agent was waiting on, for a failure to say more than "wrong
// array" (Known K14, step 1).
//
// Two integration tests have failed intermittently, only under the full
// run, and one of them took 13.6 seconds first. A duration like that is
// the whole clue: it points at something stalling rather than at a wrong
// answer. But the assertion that fails prints a short list, and a short
// list looks the same whether the message never arrived, another process
// took it, or the pump never ran.
//
// So `check` wraps the assertion and, when it fails, says what the agent
// was holding at that moment: how many turns are in flight, whether each
// pump is busy, and every inbox, outbox, job and lease row for the person.
// The next occurrence is then evidence instead of another sighting.
import type { Agent } from "../../src/runtime/index.ts"

/** A line per row, short enough to read in a test failure. */
function lines(label: string, rows: string[]): string[] {
  if (rows.length === 0) return [`  ${label}: none`]
  return [`  ${label}:`, ...rows.map((row) => `    ${row}`)]
}

/**
 * What this agent is holding, right now.
 *
 * `personId` narrows the rows to one person, which is what a test that
 * waited on one conversation wants. Left out, everything is listed.
 */
export async function waiting(agent: Agent, personId?: string): Promise<string> {
  const where = personId === undefined ? {} : { person_id: personId }
  const order = { orderBy: "seq" }

  const [inbox, outbox, jobs, leases] = await Promise.all([
    agent.store.inbox.list(where, order),
    agent.store.outbox.list(where, order),
    // Jobs are not per person, so they are listed whole either way.
    agent.store.jobs.list({}, order),
    agent.store.leases.list(where),
  ])

  const pump = (name: string, busy: number, sweeping: boolean, running: boolean): string =>
    `${name} pump busy ${busy}${sweeping ? ", looking for more" : ""}${running ? "" : " (stopped)"}`

  return [
    `agent ${agent.config.name} as ${agent.owner}`,
    `  ${agent.inFlight()} turn(s) in flight, ${pump(
      "outbox",
      agent.outbox.pump.busy(),
      agent.outbox.pump.sweeping(),
      agent.outbox.pump.running,
    )}, ${pump(
      "jobs",
      agent.jobs.pump.busy(),
      agent.jobs.pump.sweeping(),
      agent.jobs.pump.running,
    )}`,
    ...lines(
      "inbox",
      inbox.map((row) => `seq ${row.seq} ${row.channel_message_id} ${row.status}`),
    ),
    ...lines(
      "outbox",
      outbox.map(
        (row) =>
          `seq ${row.seq} ${row.idempotency_key} ${row.status} after ${row.attempts} attempt(s)${
            row.error === null ? "" : ` error ${row.error}`
          }`,
      ),
    ),
    ...lines(
      "jobs",
      jobs.map((row) => `seq ${row.seq} ${row.kind} ${row.status} held by ${row.lease_owner}`),
    ),
    ...lines(
      "leases",
      leases.map((row) => `person ${row.person_id} held by ${row.owner} until ${row.expires_at}`),
    ),
  ].join("\n")
}

/**
 * Asserts, and says what the agent was waiting on when it fails.
 *
 * The original failure is kept word for word, diff and all, with the
 * state appended. Anything thrown that is not an assertion is left alone.
 */
export async function check(
  agent: Agent,
  personId: string | undefined,
  assertions: () => void,
): Promise<void> {
  try {
    assertions()
  } catch (failure) {
    let state: string
    try {
      state = await waiting(agent, personId)
    } catch (error) {
      // The database may be the thing that is wrong, and a failure to
      // read it must not replace the failure being reported.
      state = `(the state could not be read: ${error instanceof Error ? error.message : String(error)})`
    }
    const message = failure instanceof Error ? failure.message : String(failure)
    const described = failure instanceof Error ? failure : new Error(message)
    described.message = `${message}\n\nwhat the agent was waiting on:\n${state}`
    throw described
  }
}
