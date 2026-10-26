// HAND-1 to HAND-7: opening a handover, taking it, the two directions a
// message travels while it is open, and the two clocks that end it.
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
//
// HAND-4 and HAND-5 are the two directions. Word for word is the whole
// point of the operator's: a colleague who types a price, a date or an
// apology has to see those words arrive, not a brain's idea of them. So
// `relay` touches nothing, and the only question the core asks is which
// conversation the words belong to, which is the operator's focus.
//
// HAND-6 and HAND-7 are the two clocks, and both exist for the same
// reason: a handover is a promise that a person will reply, and nobody
// should be able to forget it. The first says what happens when nobody
// comes, and it never gives up: the person is told once more and the
// operators are reminded every hour they are open. The second says what
// happens when a colleague walks away mid conversation, and it hands the
// person back to the agent rather than leaving them with nobody.
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
import { createTimeHelpers } from "../time/index.ts"
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

/**
 * HAND-4: what makes an operator's message a command rather than words
 * for the person.
 *
 * One character, and it decides who hears what, so the test is as dull
 * as it can be: a leading slash, after any space a phone keyboard added.
 * Nothing clever about where else a slash appears, because "we close 2/3
 * of the year" is a sentence somebody will send.
 */
export const COMMAND = "/"

/** HAND-4: whether this is for the agent instead of the person. */
export function isCommand(text: string): boolean {
  return text.trimStart().startsWith(COMMAND)
}

/**
 * The command with its slash taken off, which is what the brain reads.
 *
 * Stripped because `/resume` should reach a brain that has a `resume`
 * tool as the word resume. The slash is addressing, not content.
 */
export function asCommand(text: string): string {
  return text.trimStart().slice(COMMAND.length).trim()
}

/** HAND-2: what the person is told, once, the moment it opens. */
export const PERSON_TOLD = "I am passing this to a colleague. Somebody will reply here shortly."

/**
 * HAND-6: what the person is told when the ten minutes run out.
 *
 * It does not promise a time, because nobody has taken it and so
 * nobody knows. What it does is say out loud that they have not been
 * forgotten, which is the thing a person waiting actually doubts.
 */
export const PERSON_WAITED =
  "Sorry to keep you waiting. Somebody will get back to you as soon as they can."

/** HAND-6's job: a handover nobody has taken. */
export const HANDOVER_WAITING_JOB = "handover_waiting"

/** HAND-7's job: an active handover with nothing said in it. */
export const HANDOVER_IDLE_JOB = "handover_idle"

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

/** The name an operator will recognise, which is not always a name. */
export function nameOf(person: PersonRow): string {
  return person.display_name === null
    ? `${person.channel} ${person.channel_user_id}`
    : `${person.display_name} (${person.channel} ${person.channel_user_id})`
}

/**
 * HAND-5: the person's words, as the operator sees them.
 *
 * Not word for word, and deliberately: this is the one direction whose
 * reader has many conversations in a single thread, and words with no
 * name on them are words answered to the wrong person. The other
 * direction is untouched, because the person has only this one.
 */
export function forwardText(person: PersonRow, text: string): string {
  return `From ${nameOf(person)}:\n${text}`
}

/** One message on its way across a handover. */
export interface Relayed {
  /**
   * The inbox row it came from, which is what keys the send.
   *
   * A turn abandoned by a dying process is handed back by the recovery
   * sweep, so the same words can be relayed twice. Keyed by the message
   * rather than by the turn, the second attempt is dropped.
   */
  id: string
  text: string
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
  /**
   * HAND-6: when to look again at a handover nobody has taken.
   *
   * Injected, because a job is the agent's machinery and this module is
   * the rules. Absent in a test driving the rules directly, which is why
   * both of these are optional rather than required.
   */
  scheduleWaiting?: ((handover: HandoverRow, runAt: Date) => Promise<void>) | undefined
  /** HAND-7: when to check an active handover for silence. */
  scheduleIdle?: ((handover: HandoverRow, runAt: Date) => Promise<void>) | undefined
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

/** What HAND-6's job did, which is mostly nothing and says why. */
export type Waited =
  /** The ten minutes ran out: the person was told, the status moved. */
  | "told"
  /** HAND-6's repeat: the operators were reminded. */
  | "alerted"
  /** Open hours only. Nobody is woken for this. */
  | "closed"
  /** Taken, ended, or not due yet. A later job has it. */
  | "nothing"
  /** The handover is gone, so nothing is scheduled again. */
  | "gone"

/** What HAND-7's job did. */
export type Ended = "ended" | "nothing"

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
  /**
   * HAND-4: the handover this operator is talking into, if any.
   *
   * One of theirs, active, with the latest stamp. An operator holding
   * two says `take over` again to move between them.
   */
  focusOf(operator: { id: string }): Promise<HandoverRow | undefined>
  /** HAND-4: the operator's words to the person, untouched. */
  relay(request: {
    handover: HandoverRow
    items: Relayed[]
    turnId?: string | undefined
  }): Promise<number>
  /** HAND-5: the person's words to whoever is on it. */
  forward(request: {
    handover: HandoverRow
    person: PersonRow
    items: Relayed[]
    turnId?: string | undefined
  }): Promise<number>
  /** HAND-3: the first operator to ask for it gets it. */
  takeOver(request: { operator: PersonRow; person?: PersonRow | undefined }): Promise<Taken>
  /** HAND-7's first half: back to the bot. Its timeout is T6.4. */
  resume(request: { operator: PersonRow; person?: PersonRow | undefined }): Promise<Resumed>
  /**
   * HAND-6: what the waiting job does. Idempotent, and safe to run
   * early or twice: it decides from the rows, not from being called.
   */
  waitedTooLong(request: { handoverId: string }): Promise<Waited>
  /** HAND-7's second half: the idle timeout, run by its job. */
  endIfIdle(request: { handoverId: string }): Promise<Ended>
  /** HAND-3: everyone who could take one. */
  operators(): Promise<PersonRow[]>
}

/** The statuses that mean a handover is still somebody's problem. */
const OPEN: HandoverRow["status"][] = ["waiting", "active", "unanswered"]

export function createHandovers(options: HandoverOptions): Handovers {
  const { config, store, clock, events, outbox } = options
  // TIME-2: one answer to whether the agent is open, shared with every
  // other part of the core that asks.
  const time = createTimeHelpers({ config, clock })

  // Oldest first, and by when they were made an operator: ob_people has no
  // sequence, because a person is found by their channel id and never by
  // where they came in the queue.
  const operators = (): Promise<PersonRow[]> =>
    store.people.list({ role: "operator" }, { orderBy: "created_at" })

  /** HAND-7: the next time this handover could have gone quiet. */
  const scheduleIdle = (handover: HandoverRow): Promise<void> =>
    options.scheduleIdle?.(
      handover,
      new Date(clock.now().getTime() + config.handover.idleMinutes * 60_000),
    ) ?? Promise.resolve()

  const openFor = async (person: { id: string }): Promise<HandoverRow | undefined> => {
    const rows = await store.handovers.list({ person_id: person.id }, { orderBy: "seq" })
    return rows.find((row) => OPEN.includes(row.status))
  }

  /** How long this handover has been open, in whole minutes. */
  const waitedMinutes = (handover: HandoverRow): number =>
    Math.max(
      0,
      Math.floor((clock.now().getTime() - new Date(handover.opened_at).getTime()) / 60_000),
    )

  /**
   * One of the core's own two messages to the person, sent and stored.
   *
   * Stored as well as sent, because LOOP-7 gives the brain the
   * conversation and the person can see these lines in their chat. A
   * brain that cannot see them will say one of them a second time.
   *
   * Both callers write under a claim that only one process wins, so
   * neither the send nor the row can happen twice.
   */
  async function tell(
    person: PersonRow,
    text: string,
    key: string,
    turnId?: string | undefined,
  ): Promise<void> {
    await outbox.queue({
      personId: person.id,
      ...(turnId !== undefined ? { turnId } : {}),
      kind: "reply",
      channel: person.channel,
      channelUserId: person.channel_user_id,
      text,
      idempotencyKey: key,
      urgent: true,
    })
    await store.messages.insert({
      person_id: person.id,
      ...(turnId !== undefined ? { turn_id: turnId } : {}),
      direction: "outbound",
      author: "agent",
      text,
      channel: person.channel,
      created_at: clock.now().toISOString(),
    })
  }

  /** HAND-2: everything an operator needs to decide whether to pick it up. */
  function alertText(handover: HandoverRow, person: PersonRow, again = false): string {
    const lines = [
      // HAND-6: a reminder says so, and says how long, because an
      // operator who has seen this alert twice needs to know which it is.
      ...(again
        ? [`Still waiting after ${waitedMinutes(handover)} minutes, nobody has taken this.`]
        : []),
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

  /**
   * One alert per operator per handover, however many times this runs.
   *
   * HAND-6's reminder is a second alert on purpose, so it carries the
   * moment it was sent in its key. Without that the outbox would drop
   * it as a duplicate of the first and the reminder would be silent.
   */
  async function alert(
    handover: HandoverRow,
    person: PersonRow,
    again?: { since: string },
  ): Promise<number> {
    const told = await operators()
    const text = alertText(handover, person, again !== undefined)

    for (const operator of told) {
      await outbox.queue({
        personId: operator.id,
        ...(handover.turn_id !== null ? { turnId: handover.turn_id } : {}),
        kind: "operator_alert",
        channel: operator.channel,
        channelUserId: operator.channel_user_id,
        text,
        idempotencyKey:
          again === undefined
            ? `handover:${handover.id}:alert:${operator.id}`
            : `handover:${handover.id}:alert:${operator.id}:${again.since}`,
        // The first one interrupts. A reminder takes its turn, because
        // the operator it is reminding may be mid conversation with
        // somebody else.
        urgent: again === undefined,
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
    await tell(person, PERSON_TOLD, `handover:${row.id}:person`, request.turnId)

    // HAND-6: the clock starts the moment it opens, and runs whether or
    // not anything below this line works.
    await options.scheduleWaiting?.(
      row,
      new Date(clock.now().getTime() + config.handover.noOperatorMinutes * 60_000),
    )

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
      if (wanted.operator_id !== request.operator.id) {
        return { kind: "already_taken", handover: wanted, by }
      }
      // HAND-4: theirs already, so this is an operator saying which of
      // their conversations they are on now. Section 10 has no tool for
      // moving focus, and this is the sentence they would say anyway.
      const [again] = await store.handovers.update(
        { id: wanted.id },
        { focused_at: clock.now().toISOString() },
      )
      await scheduleIdle(again ?? wanted)
      return { kind: "taken", handover: again ?? wanted }
    }

    // HAND-3: one conditional update, so of two operators asking together
    // exactly one finds something to claim.
    const [claimed] = await store.handovers.update(
      { id: wanted.id },
      {
        status: "active",
        operator_id: request.operator.id,
        taken_at: clock.now().toISOString(),
        // HAND-4: taking one is turning to it, so an operator who holds
        // only this one can start typing without a second step.
        focused_at: clock.now().toISOString(),
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

    // HAND-7: the silence is measured from here.
    await scheduleIdle(claimed)

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

  /**
   * HAND-7: the one way a handover closes, for either of its reasons.
   *
   * One conditional claim (DATA-4), so an operator saying `resume` at the
   * same moment the idle job fires produces one close, one note in the
   * history and one event rather than two of each.
   */
  async function closeWith(
    row: HandoverRow,
    why: "resume" | "idle",
    by?: string,
  ): Promise<HandoverRow | undefined> {
    const [closed] = await store.handovers.update(
      { id: row.id },
      {
        status: "closed",
        ended_reason: why,
        ended_at: clock.now().toISOString(),
      },
      { isIn: { status: OPEN } },
    )
    if (closed === undefined) return undefined

    // HAND-7: the brain gets a note that a handover happened. Stored as a
    // notice, so the next turn's history carries it and the brain cannot
    // answer as though it had been there all along.
    await store.messages.insert({
      person_id: closed.person_id,
      direction: "inbound",
      author: "notice",
      text: BACK_WITH_BOT,
      channel: (await store.people.byId(closed.person_id))?.channel ?? "",
      created_at: clock.now().toISOString(),
    })

    await events.about({ personId: closed.person_id }).record("handover_ended", {
      handoverId: closed.id,
      why,
      ...(by !== undefined ? { operatorId: by } : {}),
      heldMinutes:
        closed.taken_at === null
          ? 0
          : Math.floor((clock.now().getTime() - new Date(closed.taken_at).getTime()) / 60_000),
    })

    return closed
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

    const closed = await closeWith(wanted, "resume", request.operator.id)
    return closed === undefined ? { kind: "none" } : { kind: "resumed", handover: closed }
  }

  /**
   * HAND-4: which of this operator's conversations their words go to.
   *
   * Read from the handovers rather than from the operator's own row, so
   * a focus cannot point at a handover that has been closed or at one
   * somebody else has taken: the row that carries the focus is the row
   * that carries `status` and `operator_id`.
   *
   * Falling back to `taken_at` matters for a handover claimed by
   * anything that does not stamp the focus.
   */
  async function focusOf(operator: { id: string }): Promise<HandoverRow | undefined> {
    const held = await store.handovers.list({ operator_id: operator.id, status: "active" })
    const turnedTo = (row: HandoverRow): number =>
      new Date(row.focused_at ?? row.taken_at ?? row.opened_at).getTime()
    // `seq` breaks a tie, so two stamps in the same millisecond still
    // decide the same way every time rather than by whatever order
    // the rows came back in. The newer handover wins.
    return [...held].sort((a, b) => turnedTo(b) - turnedTo(a) || b.seq - a.seq)[0]
  }

  /**
   * HAND-4: the operator's words, as they typed them.
   *
   * Nothing is added, not even a name: the person asked for a human and
   * is now talking to one, and a core that prefixed every line would be
   * putting itself back in the middle of it.
   *
   * Stored under the person's conversation as the operator, which is
   * what HAND-7 means by the operator's messages being in the history.
   */
  async function relay(request: {
    handover: HandoverRow
    items: Relayed[]
    turnId?: string | undefined
  }): Promise<number> {
    const person = await store.people.byId(request.handover.person_id)
    if (person === null) return 0

    let sent = 0
    for (const item of request.items) {
      const key = `handover:${request.handover.id}:relay:${item.id}`
      // The outbox would drop a second send on its own. This read is
      // here for the history row, which has no key of its own: without
      // it, a turn that ran twice would leave the same sentence in the
      // conversation twice and the brain would read it twice.
      if ((await store.outbox.find({ idempotency_key: key })) !== null) continue

      await store.messages.insert({
        person_id: person.id,
        ...(request.turnId !== undefined ? { turn_id: request.turnId } : {}),
        direction: "outbound",
        author: "operator",
        text: item.text,
        channel: person.channel,
        created_at: clock.now().toISOString(),
      })
      await outbox.queue({
        personId: person.id,
        ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
        kind: "reply",
        channel: person.channel,
        channelUserId: person.channel_user_id,
        text: item.text,
        idempotencyKey: key,
        // A person is waiting on a colleague who is typing right now.
        urgent: true,
      })
      sent++
    }
    // HAND-7: a colleague who is typing has not walked away.
    if (sent > 0 && request.handover.status === "active") {
      await scheduleIdle(request.handover)
    }
    return sent
  }

  /**
   * HAND-5: the person's words, to the operator who has it, or to all
   * of them while nobody has.
   *
   * Keyed by the message, so the same words are never forwarded twice,
   * and not urgent: a person who writes three times while they wait
   * must not push the alert that said a handover opened out of sight.
   */
  async function forward(request: {
    handover: HandoverRow
    person: PersonRow
    items: Relayed[]
    turnId?: string | undefined
  }): Promise<number> {
    const { handover, person } = request
    const to =
      handover.operator_id === null
        ? await operators()
        : // Only the one on it. The others were told who took it
          // (HAND-3), and a conversation two people are typing into is
          // worse than one the wrong people are not reading.
          [await store.people.byId(handover.operator_id)].filter(
            (one): one is PersonRow => one !== null,
          )

    let sent = 0
    for (const item of request.items) {
      if (item.text === "") continue
      for (const operator of to) {
        await outbox.queue({
          personId: operator.id,
          ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
          kind: "operator_alert",
          channel: operator.channel,
          channelUserId: operator.channel_user_id,
          text: forwardText(person, item.text),
          idempotencyKey: `handover:${handover.id}:fwd:${item.id}:${operator.id}`,
        })
        sent++
      }
    }
    // HAND-7: the person speaking is not silence either, so the half
    // hour starts again from here.
    if (handover.status === "active") await scheduleIdle(handover)
    return sent
  }

  /**
   * HAND-7: when either side last said anything in this conversation.
   *
   * Two bounded reads rather than one, because `Where` has no OR and a
   * read that needs one is a read nobody can check. Notices are not
   * words from either side, so they do not count: the core telling the
   * person it is passing them on must not look like the colleague
   * replying.
   *
   * The floor is when it was taken. A colleague who takes one and says
   * nothing has still been silent for however long.
   */
  async function lastWord(row: HandoverRow): Promise<number> {
    const latest = async (author: string): Promise<number> => {
      const [found] = await store.messages.list(
        { person_id: row.person_id, author },
        { orderBy: "seq", ascending: false, limit: 1 },
      )
      return found === undefined ? 0 : new Date(found.created_at).getTime()
    }

    return Math.max(
      new Date(row.taken_at ?? row.opened_at).getTime(),
      await latest("person"),
      await latest("operator"),
    )
  }

  /**
   * HAND-6: a handover nobody has taken, ten minutes on and every hour
   * after that.
   *
   * Everything is decided from the rows, so running this early, late or
   * twice is safe, and a job that finds nothing to do says why. Both
   * transitions are conditional updates (DATA-4), because two processes
   * running the same job must not tell the person twice.
   */
  async function waitedTooLong(request: { handoverId: string }): Promise<Waited> {
    const row = await store.handovers.byId(request.handoverId)
    if (row === null) return "gone"
    if (row.status === "active" || row.status === "closed") return "nothing"

    const now = clock.now()
    const repeatMs = config.handover.alertRepeatMinutes * 60_000

    if (row.status === "waiting") {
      const due = new Date(row.opened_at).getTime() + config.handover.noOperatorMinutes * 60_000
      // Early. Whatever scheduled this asked for the wrong time, so ask
      // for the right one rather than acting now.
      if (due > now.getTime()) {
        await options.scheduleWaiting?.(row, new Date(due))
        return "nothing"
      }

      const [changed] = await store.handovers.update(
        { id: row.id, status: "waiting" },
        { status: "unanswered", alerted_at: now.toISOString() },
      )
      if (changed === undefined) return "nothing"

      const person = await store.people.byId(changed.person_id)
      if (person !== null) {
        // HAND-6: the person first. They are the one who has been
        // waiting, and they are owed the truth: nobody has come yet.
        await tell(person, PERSON_WAITED, `handover:${changed.id}:waited`)
        await alert(changed, person, { since: now.toISOString() })
      }

      await events.about({ personId: changed.person_id }).record("handover_unanswered", {
        handoverId: changed.id,
        reason: changed.reason,
        waitedMinutes: waitedMinutes(changed),
      })

      // HAND-6: it stays open, so the next reminder is already booked.
      await options.scheduleWaiting?.(changed, new Date(now.getTime() + repeatMs))
      return "told"
    }

    // HAND-6's hourly reminder, for a handover already `unanswered`.
    const since = new Date(row.alerted_at ?? row.opened_at).getTime()
    if (since + repeatMs > now.getTime()) {
      await options.scheduleWaiting?.(row, new Date(since + repeatMs))
      return "nothing"
    }

    // HAND-6: during opening hours only. Outside them the reminder is
    // skipped rather than queued, because an operator woken at three in
    // the morning by a bot learns to mute it.
    if (!time.isOpen(now)) {
      await options.scheduleWaiting?.(row, new Date(now.getTime() + repeatMs))
      return "closed"
    }

    const [stamped] = await store.handovers.update(
      { id: row.id, status: "unanswered" },
      { alerted_at: now.toISOString() },
      { lte: { alerted_at: new Date(since).toISOString() } },
    )
    if (stamped === undefined) return "nothing"

    const person = await store.people.byId(stamped.person_id)
    if (person !== null) await alert(stamped, person, { since: now.toISOString() })
    await options.scheduleWaiting?.(stamped, new Date(now.getTime() + repeatMs))
    return "alerted"
  }

  /**
   * HAND-7: an active handover with nothing said in it for half an hour
   * goes back to the agent.
   *
   * The person is not told, because from where they sit nothing has
   * happened: the next thing they say is answered, which is better than
   * silence. The operator is told, because they think they still have
   * it, and the next thing they type would otherwise go to the agent
   * instead of to the person (HAND-4).
   */
  async function endIfIdle(request: { handoverId: string }): Promise<Ended> {
    const row = await store.handovers.byId(request.handoverId)
    if (row === null || row.status !== "active") return "nothing"

    const silentSince = await lastWord(row)
    const due = silentSince + config.handover.idleMinutes * 60_000
    // Somebody spoke after this job was scheduled, so a later job has it.
    if (due > clock.now().getTime()) {
      await options.scheduleIdle?.(row, new Date(due))
      return "nothing"
    }

    const closed = await closeWith(row, "idle")
    if (closed === undefined) return "nothing"

    const operator =
      closed.operator_id === null ? null : await store.people.byId(closed.operator_id)
    const person = await store.people.byId(closed.person_id)
    if (operator !== null) {
      await outbox.queue({
        personId: operator.id,
        kind: "operator_alert",
        channel: operator.channel,
        channelUserId: operator.channel_user_id,
        text: `${
          person === null ? "That handover" : nameOf(person)
        } has gone back to the agent after ${config.handover.idleMinutes} minutes with nothing said. What you type now goes to the agent, not to them.`,
        idempotencyKey: `handover:${closed.id}:idle:${operator.id}`,
      })
    }

    return "ended"
  }

  return {
    openFor,
    open,
    takeOver,
    resume,
    operators,
    focusOf,
    relay,
    forward,
    waitedTooLong,
    endIfIdle,
  }
}
