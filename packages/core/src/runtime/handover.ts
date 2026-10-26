// HAND-1 to HAND-3: opening a handover, and the first operator to take it.
//
// A handover is the one state in this core where the agent stops being the
// thing that answers. Everything here is therefore written so that the
// person is never left believing a machine is still working on it: they
// are told once, immediately, and the operators are told separately with
// enough to act on.
//
// Three rules shape the code.
//
// One open handover per person, enforced by a unique index rather than by
// looking first (HAND-1, HAND-2). Two triggers can fire in one turn, and
// two processes can trigger at once, and neither may tell the person twice
// or show the operators the same conversation under two rows.
//
// The alert goes out even when the summary cannot be written. HAND-2 gives
// the brain one job in a handover, and a brain that is down must not also
// cost the operators their alert.
//
// Taking it is a conditional claim, like every other claim here (DATA-4).
// Two operators saying "take over" at the same moment is the normal case
// in a busy shop, and exactly one of them has to win.
import type { OpenboxConfig } from "../config/index.ts"
import {
  isUniqueViolation,
  type HandoverReason,
  type HandoverRow,
  type PersonRow,
  type Store,
} from "../store/index.ts"
import type { Question } from "../providers/decision/types.ts"
import type { Clock } from "../testing/clock.ts"
import type { EventWriter } from "./events.ts"
import type { Outbox } from "./outbox.ts"

/** HAND-1: the question LOOP-8 step 1 asks alongside routing. */
export const WANTS_HUMAN = "wants_human"

/**
 * HAND-1: whether this person wants a human being.
 *
 * Deliberately not "are they annoyed": that is LEARN-1's frustration
 * question, which is for the digest. This one opens a handover, so it
 * asks about what they want rather than how they feel.
 */
export function wantsHumanQuestion(): Extract<Question, { type: "yesno" }> {
  return {
    type: "yesno",
    instructions:
      "Does this person want to be put through to a human being, rather than have the agent keep trying?",
    whenTrue:
      "They have asked for a person, a manager or a call back, or they are upset enough that only a person will settle it.",
    whenFalse:
      "They are asking something the agent might answer, or they are mid task and have not asked for anyone.",
  }
}

/** HAND-2: what the person is told, once, the moment it opens. */
export const PERSON_TOLD = "I am passing this to a colleague. Somebody will reply here shortly."

/** HAND-7: what the brain is told on the way back, in the history. */
export const BACK_WITH_BOT =
  "A colleague was replying to this person directly for a while. You are answering them again now."

/** The reasons in words, for an operator who has to decide what to do. */
const WHY: Record<HandoverReason, string> = {
  escalate: "the agent handed it over",
  wants_human: "they sound like they want a person",
  gate_block_repeat: "the agent was stopped from acting twice in a row",
  low_confidence_repeat: "the agent was unsure twice in a row",
  tool_failed_repeat: "the same thing failed twice",
  spend_cap: "the agent has spent its limit for today",
  step_cap: "the agent went round in circles",
  brains_failed: "the agent could not answer at all",
  operator: "an operator started it",
}

export interface HandoverOptions {
  config: OpenboxConfig
  store: Store
  clock: Clock
  events: EventWriter
  outbox: Outbox
  /**
   * HAND-2: the brain's three lines, written from the last messages.
   *
   * Injected because nothing else here knows about brains, and because a
   * handover opened by an operator is summarised the same way as one
   * opened by a turn. Returning undefined is allowed and expected: every
   * brain can be down, and the alert still has to go out.
   */
  summarise?:
    | ((request: {
        person: PersonRow
        reason: HandoverReason
      }) => Promise<{ text: string; costUsd: number } | undefined>)
    | undefined
}

export interface Opened {
  handover: HandoverRow
  /** False when this person was already in one, so nobody was told twice. */
  opened: boolean
}

export type Taken =
  | { kind: "taken"; handover: HandoverRow }
  /** HAND-3: somebody else got there first. */
  | { kind: "already_taken"; handover: HandoverRow; by: PersonRow | null }
  | { kind: "none" }

export type Resumed = { kind: "resumed"; handover: HandoverRow } | { kind: "none" }

export interface Handovers {
  /** LOOP-5 step 5: the handover this person is in, if any. */
  openFor(person: { id: string }): Promise<HandoverRow | undefined>
  /** HAND-1 and HAND-2. Opening one twice for a person opens one. */
  open(request: {
    person: PersonRow
    reason: HandoverReason
    detail?: string | undefined
    turnId?: string | undefined
  }): Promise<Opened>
  /** HAND-3: the first operator to ask for it gets it. */
  takeOver(request: { operator: PersonRow; person?: PersonRow | undefined }): Promise<Taken>
  /** HAND-7's first half: back to the bot. Its timeout is T6.4. */
  resume(request: { operator: PersonRow; person?: PersonRow | undefined }): Promise<Resumed>
  /** HAND-3: everyone who could take one. */
  operators(): Promise<PersonRow[]>
}

/** The statuses that mean a handover is still somebody's problem. */
const OPEN: HandoverRow["status"][] = ["waiting", "active", "unanswered"]

export function createHandovers(options: HandoverOptions): Handovers {
  const { store, clock, events, outbox } = options

  // Oldest first, and by when they were made an operator: ob_people has no
  // sequence, because a person is found by their channel id and never by
  // where they came in the queue.
  const operators = (): Promise<PersonRow[]> =>
    store.people.list({ role: "operator" }, { orderBy: "created_at" })

  const openFor = async (person: { id: string }): Promise<HandoverRow | undefined> => {
    const rows = await store.handovers.list({ person_id: person.id }, { orderBy: "seq" })
    return rows.find((row) => OPEN.includes(row.status))
  }

  /** The name an operator will recognise, which is not always a name. */
  const nameOf = (person: PersonRow): string =>
    person.display_name === null
      ? `${person.channel} ${person.channel_user_id}`
      : `${person.display_name} (${person.channel} ${person.channel_user_id})`

  /** HAND-2: everything an operator needs to decide whether to pick it up. */
  function alertText(handover: HandoverRow, person: PersonRow): string {
    const lines = [
      `Handover: ${nameOf(person)}`,
      `Why: ${WHY[handover.reason]}${handover.detail === null ? "" : ` - ${handover.detail}`}`,
    ]
    lines.push(
      handover.summary === null || handover.summary === ""
        ? "Summary: not available, so read the conversation."
        : `Summary:\n${handover.summary}`,
    )
    lines.push('To take it, say "take over".')
    return lines.join("\n\n")
  }

  /** One alert per operator per handover, however many times this runs. */
  async function alert(handover: HandoverRow, person: PersonRow): Promise<number> {
    const told = await operators()
    const text = alertText(handover, person)

    for (const operator of told) {
      await outbox.queue({
        personId: operator.id,
        ...(handover.turn_id !== null ? { turnId: handover.turn_id } : {}),
        kind: "operator_alert",
        channel: operator.channel,
        channelUserId: operator.channel_user_id,
        text,
        idempotencyKey: `handover:${handover.id}:alert:${operator.id}`,
        urgent: true,
      })
    }
    return told.length
  }

  async function open(request: {
    person: PersonRow
    reason: HandoverReason
    detail?: string | undefined
    turnId?: string | undefined
  }): Promise<Opened> {
    const { person, reason } = request

    const already = await openFor(person)
    if (already !== undefined) return { handover: already, opened: false }

    let row: HandoverRow
    try {
      row = await store.handovers.insert({
        person_id: person.id,
        ...(request.turnId !== undefined ? { turn_id: request.turnId } : {}),
        reason,
        detail: request.detail ?? null,
        status: "waiting",
        opened_at: clock.now().toISOString(),
        created_at: clock.now().toISOString(),
      })
    } catch (error) {
      // HAND-2: the unique index did the deciding. Another trigger, or
      // another process, opened one between the read above and this
      // insert, and that one is the handover.
      if (isUniqueViolation(error)) {
        const theirs = await openFor(person)
        if (theirs !== undefined) return { handover: theirs, opened: false }
      }
      throw error
    }

    const scoped = events.about({
      personId: person.id,
      ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
    })

    // HAND-2: the person is told first. They are the one waiting, and the
    // summary below can take a brain call.
    await outbox.queue({
      personId: person.id,
      ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
      kind: "reply",
      channel: person.channel,
      channelUserId: person.channel_user_id,
      text: PERSON_TOLD,
      idempotencyKey: `handover:${row.id}:person`,
      urgent: true,
    })

    // HAND-2: the brain's one job in a handover. A failure here costs the
    // alert its summary and nothing else.
    let written: { text: string; costUsd: number } | undefined
    try {
      written = await options.summarise?.({ person, reason })
    } catch {
      written = undefined
    }
    if (written !== undefined && written.text !== "") {
      const [updated] = await store.handovers.update({ id: row.id }, { summary: written.text })
      if (updated !== undefined) row = updated
    }

    const alerted = await alert(row, person)

    await scoped.record("handover_started", {
      handoverId: row.id,
      reason,
      ...(request.detail !== undefined ? { detail: request.detail } : {}),
      operators: alerted,
      summarised: written !== undefined,
      // The one brain call that happens outside a turn, so the only
      // place its cost is written down (T7.3 has to count it).
      costUsd: written?.costUsd ?? 0,
    })
    // Section 17: any handover starts is a flag. The digest counts these.
    await scoped.flag("handover", {
      handoverId: row.id,
      reason,
      ...(request.detail !== undefined ? { detail: request.detail } : {}),
    })

    return { handover: row, opened: true }
  }

  async function takeOver(request: {
    operator: PersonRow
    person?: PersonRow | undefined
  }): Promise<Taken> {
    const wanted =
      request.person !== undefined
        ? await openFor(request.person)
        : // Oldest first, because the person who has waited longest is the
          // one an operator meant to pick up.
          (await store.handovers.list({}, { orderBy: "seq" })).find(
            (row) => row.status === "waiting" || row.status === "unanswered",
          )

    if (wanted === undefined) return { kind: "none" }

    if (wanted.status === "active") {
      const by = wanted.operator_id === null ? null : await store.people.byId(wanted.operator_id)
      return wanted.operator_id === request.operator.id
        ? { kind: "taken", handover: wanted }
        : { kind: "already_taken", handover: wanted, by }
    }

    // HAND-3: one conditional update, so of two operators asking together
    // exactly one finds something to claim.
    const [claimed] = await store.handovers.update(
      { id: wanted.id },
      {
        status: "active",
        operator_id: request.operator.id,
        taken_at: clock.now().toISOString(),
      },
      { isIn: { status: ["waiting", "unanswered"] } },
    )

    if (claimed === undefined) {
      const now = await store.handovers.byId(wanted.id)
      const by =
        now?.operator_id === null || now?.operator_id === undefined
          ? null
          : await store.people.byId(now.operator_id)
      return { kind: "already_taken", handover: now ?? wanted, by }
    }

    const person = await store.people.byId(claimed.person_id)

    await events.about({ personId: claimed.person_id }).record("handover_taken", {
      handoverId: claimed.id,
      operatorId: request.operator.id,
      waitedMs: Math.max(0, clock.now().getTime() - new Date(claimed.opened_at).getTime()),
    })

    // HAND-3: the other operators are told who took it, so two people do
    // not both start typing.
    const others = (await operators()).filter((one) => one.id !== request.operator.id)
    for (const other of others) {
      await outbox.queue({
        personId: other.id,
        kind: "operator_alert",
        channel: other.channel,
        channelUserId: other.channel_user_id,
        text: `${nameOf(request.operator)} took the handover for ${
          person === null ? "that person" : nameOf(person)
        }.`,
        idempotencyKey: `handover:${claimed.id}:taken:${other.id}`,
      })
    }

    return { kind: "taken", handover: claimed }
  }

  async function resume(request: {
    operator: PersonRow
    person?: PersonRow | undefined
  }): Promise<Resumed> {
    const wanted =
      request.person !== undefined
        ? await openFor(request.person)
        : (
            await store.handovers.list({ operator_id: request.operator.id }, { orderBy: "seq" })
          ).find((row) => row.status === "active")

    if (wanted === undefined) return { kind: "none" }

    const [closed] = await store.handovers.update(
      { id: wanted.id },
      {
        status: "closed",
        ended_reason: "resume",
        ended_at: clock.now().toISOString(),
      },
      { isIn: { status: OPEN } },
    )
    if (closed === undefined) return { kind: "none" }

    // HAND-7: the brain gets a note that a handover happened. Stored as a
    // notice, so the next turn's history carries it and the brain cannot
    // answer as though it had been there all along.
    await store.messages.insert({
      person_id: closed.person_id,
      direction: "inbound",
      author: "notice",
      text: BACK_WITH_BOT,
      channel: (await store.people.byId(closed.person_id))?.channel ?? "",
    })

    await events.about({ personId: closed.person_id }).record("handover_ended", {
      handoverId: closed.id,
      why: "resume",
      operatorId: request.operator.id,
    })

    return { kind: "resumed", handover: closed }
  }

  return { openFor, open, takeOver, resume, operators }
}
