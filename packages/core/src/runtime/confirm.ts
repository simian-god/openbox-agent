// CONF-1 to CONF-8: structured confirmation.
//
// The gate decides whether a call is plausible. This decides whether the
// person actually asked for it. They are different questions, and an
// irreversible call needs both, because the gate asks a model and a model
// can be talked into things by the conversation it is reading.
//
// So nothing here depends on the decision model, or on the brain. A
// pending action is a row, and it runs when four things hold (CONF-4):
// the confirmation is genuine, it came from the same person, the action is
// still open, and the arguments have not changed since they were shown.
// Any one of those failing is a rejection, not a retry.
//
// The part that is easiest to get wrong is the fourth. A confirmation is
// for the call the person was shown, not for the tool in general. If the
// brain revises the party size after asking, the old Confirm must not run
// the new call. That is what `args_hash` is for.
import { createHmac, randomInt, timingSafeEqual, createHash } from "node:crypto"
import type { OpenboxConfig } from "../config/index.ts"
import type { PendingActionRow, PersonRow, Store } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"
import type { Tool, ToolContext } from "../tools/index.ts"
import type { EventWriter } from "./events.ts"
import type { Jobs } from "./jobs.ts"
import type { Outbox } from "./outbox.ts"
import type { Sender } from "./sender.ts"
import { stableStringify } from "./version.ts"

/** CONF-3's payload prefix, so a tap can be told from anything else. */
export const PAYLOAD_PREFIX = "ob1"

/** CONF-3: `c` confirms, `x` cancels. */
export type Verb = "c" | "x"

/** CONF-8: the word that cancels a pending action without a button. */
export const CANCEL_WORD = "cancel"

/** The job that expires one (CONF-1). */
export const EXPIRE_JOB = "pending_action_expire"

/** How many digits CONF-1's code has. */
const CODE_DIGITS = 4

/** CONF-1: a code that is not a password, only a second factor to a person. */
export function newCode(): string {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0")
}

/**
 * CONF-4's last rule, as one string.
 *
 * `stableStringify` so key order cannot make the same arguments look
 * different, which would reject a confirmation that was perfectly good.
 */
export function argsHash(args: unknown): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex").slice(0, 32)
}

function signature(verb: Verb, actionId: string, personId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${verb}.${actionId}.${personId}`)
    .digest("hex")
    .slice(0, 32)
}

/**
 * The smallest hidden payload a button we ship glue for can carry.
 *
 * Telegram's own docs say an inline button's `callback_data` is 1 to 64
 * bytes, which is the tightest of the four channels: Discord allows 100
 * and WhatsApp is roomier still. T10.4 found the payload was 75, so a
 * Telegram confirm button could not be built at all.
 */
export const MAX_PAYLOAD_BYTES = 64

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHORT_ID = /^[A-Za-z0-9_-]{22}$/

/**
 * CONF-3: an action id written as 22 characters rather than 36.
 *
 * The same sixteen bytes, in base64url instead of hex with dashes. That
 * is what brings the payload to 61 bytes and inside Telegram's limit,
 * with the signature untouched: nothing is given up here, it is only
 * spelled shorter.
 *
 * Anything that is not an id is handed back exactly as it came, so a
 * payload built from something odd parses the way it always did.
 */
export function shortId(id: string): string {
  if (!UUID.test(id)) return id
  return Buffer.from(id.replace(/-/g, ""), "hex").toString("base64url")
}

/** The other direction, for reading a payload. */
export function longId(short: string): string {
  if (!SHORT_ID.test(short)) return short
  const hex = Buffer.from(short, "base64url").toString("hex")
  if (hex.length !== 32) return short
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-")
}

/**
 * CONF-3: `ob1.<verb>.<actionId>.<signature>`, with the action id in
 * short form.
 *
 * The signature is over the id itself, never over the short form, so a
 * payload carrying the id in full is the same authorisation written out
 * differently and `parsePayload` reads both. 22 base64url characters hold
 * four bits more than sixteen bytes need, so a handful of different short
 * forms decode to the same id: they are the same action, confirmed by the
 * same person, and CONF-5 already decides what happens when one action is
 * resolved twice.
 */
export function buttonPayload(
  verb: Verb,
  actionId: string,
  personId: string,
  secret: string,
): string {
  return [
    PAYLOAD_PREFIX,
    verb,
    shortId(actionId),
    signature(verb, actionId, personId, secret),
  ].join(".")
}

export interface ParsedPayload {
  verb: Verb
  actionId: string
  signature: string
}

/** Reads a payload without checking it. Shape only. */
export function parsePayload(text: string): ParsedPayload | null {
  const parts = text.split(".")
  if (parts.length !== 4) return null
  const [prefix, verb, actionId, sig] = parts
  if (prefix !== PAYLOAD_PREFIX) return null
  if (verb !== "c" && verb !== "x") return null
  if (actionId === undefined || actionId === "" || sig === undefined || sig === "") return null
  // Back to the id itself, so everything downstream, the signature check
  // and the row lookup included, works on one shape.
  return { verb, actionId: longId(actionId), signature: sig }
}

/**
 * Whether a payload was signed for this person.
 *
 * Compared in constant time. A signature check that returns early on the
 * first wrong character tells an attacker how much of a guess was right,
 * and this one is cheap to make constant.
 */
export function payloadIsValid(parsed: ParsedPayload, personId: string, secret: string): boolean {
  const expected = signature(parsed.verb, parsed.actionId, personId, secret)
  const given = Buffer.from(parsed.signature)
  const want = Buffer.from(expected)
  if (given.length !== want.length) return false
  return timingSafeEqual(given, want)
}

/** What the core needs to make and resolve pending actions. */
export interface ConfirmOptions {
  config: OpenboxConfig
  store: Store
  clock: Clock
  events: EventWriter
  outbox: Outbox
  jobs: Jobs
  sender: Sender
  /**
   * `OPENBOX_SECRET` (CONF-3). Required only for an agent that has an
   * irreversible tool, since nothing else signs anything.
   */
  secret: string
  /** So a confirmation can run the handler it was made for. */
  toolByName: (name: string) => Tool | undefined
  /**
   * TOOL-4's context for the handler, built per person.
   *
   * Async because it reads the person's facts, and a tool run from a
   * confirmation has to see the same person a tool run inside a step sees.
   * A handler that behaved differently depending on which path reached it
   * is the one difference nobody would think to test for.
   */
  /**
   * CONF-4 and MEDIA-4: the action is passed as well as the person, so a
   * tool that sends a file from a confirmed call can key it by the
   * action. Without that the same confirmed call retried would send the
   * file twice, and a confirmed call is the one place where that matters
   * most.
   */
  contextFor: (person: PersonRow, action: { id: string }) => Promise<ToolContext>
}

export interface CreateRequest {
  person: PersonRow
  turnId: string
  tool: Tool
  /** Already validated against the tool's schema (LOOP-8 step 6). */
  args: Record<string, unknown>
  taskId?: string | undefined
}

/** What resolving an inbound confirmation did. */
export type Resolution =
  | { kind: "executed"; action: PendingActionRow; result: unknown }
  | { kind: "failed"; action: PendingActionRow; error: string }
  | { kind: "cancelled"; action: PendingActionRow }
  | { kind: "already_done"; action: PendingActionRow }
  | { kind: "rejected"; why: RejectReason; action?: PendingActionRow | undefined }

/** Why CONF-4 refused. Named, because the trace has to say which rule. */
export type RejectReason =
  | "no_such_action"
  | "bad_signature"
  | "another_person"
  | "not_pending"
  | "expired"
  | "arguments_changed"

export interface Confirmations {
  /** CONF-1 and CONF-2: makes one, and asks the person. */
  create(request: CreateRequest): Promise<PendingActionRow>
  /**
   * CONF-4, CONF-5 and CONF-8: resolves a tap, a typed code or the word
   * cancel. Returns null when this message is not a confirmation at all,
   * which is the common case and must stay cheap.
   */
  resolve(input: {
    person: PersonRow
    text?: string | undefined
    payload?: string | undefined
  }): Promise<Resolution | null>
  /** The expiry job's handler (CONF-1). */
  expire(actionId: string): Promise<void>
  /** CONF-6: cancels whatever is pending, because something replaced it. */
  cancelOpen(person: PersonRow, why: string): Promise<PendingActionRow[]>
}

export function createConfirmations(options: ConfirmOptions): Confirmations {
  const { config, store, clock, events, outbox, jobs, sender, secret, toolByName } = options

  const forPerson = (person: PersonRow, turnId?: string) =>
    events.about({ personId: person.id, ...(turnId !== undefined ? { turnId } : {}) })

  /**
   * CONF-4 refusing, recorded and flagged together.
   *
   * One function because there are six reasons and LEARN-1 wants a flag
   * for every one of them. Six call sites each doing both is six chances
   * to add a seventh reason and record it without flagging it, and the
   * missing flag would be invisible: the event would still be in the
   * trace, so nothing would look broken until a builder wondered why the
   * digest was quiet.
   */
  async function reject(
    person: PersonRow,
    why: RejectReason,
    props: Record<string, unknown>,
  ): Promise<void> {
    const scoped = forPerson(person)
    await scoped.record("confirmation_rejected", { why, ...props })
    await scoped.flag("confirmation_rejected", { why, ...props })
  }

  /** CONF-2: the message the core sends, not the brain. */
  async function ask(action: PendingActionRow, person: PersonRow): Promise<void> {
    const canTap = sender.capabilities(person.channel).buttons

    await outbox.queue({
      personId: person.id,
      ...(action.turn_id !== null ? { turnId: action.turn_id } : {}),
      kind: "confirm",
      channel: person.channel,
      channelUserId: person.channel_user_id,
      text: canTap
        ? action.summary
        : `${action.summary}\n\nReply ${action.code} to confirm, or ${CANCEL_WORD} to stop.`,
      ...(canTap
        ? {
            buttons: [
              { label: "Confirm", payload: buttonPayload("c", action.id, person.id, secret) },
              { label: "Cancel", payload: buttonPayload("x", action.id, person.id, secret) },
            ],
          }
        : {}),
      // One confirm message per action, however many times this runs.
      idempotencyKey: `confirm:${action.id}`,
      urgent: true,
    })
  }

  async function cancelOpen(person: PersonRow, why: string): Promise<PendingActionRow[]> {
    const open = await store.pendingActions.list(
      { person_id: person.id, status: "pending" },
      { orderBy: "seq" },
    )
    const cancelled: PendingActionRow[] = []

    for (const action of open) {
      // DATA-4: a conditional claim, so a cancellation and a confirmation
      // racing each other cannot both win.
      const [row] = await store.pendingActions.update(
        { id: action.id, status: "pending" },
        { status: "cancelled", decided_at: clock.now().toISOString(), error: why },
      )
      if (row !== undefined) cancelled.push(row)
    }
    return cancelled
  }

  return {
    cancelOpen,

    async create(request: CreateRequest): Promise<PendingActionRow> {
      const { person, turnId, tool, args, taskId } = request

      // CONF-6, as far as it goes before tasks exist (T4.2): a new pending
      // action replaces whatever was pending for this person. One question
      // at a time, so a typed code is never ambiguous and nobody is asked
      // to confirm two things at once.
      await cancelOpen(person, "replaced by a newer pending action")

      const expiresAt = new Date(clock.now().getTime() + config.pendingActionMinutes * 60_000)

      const action = await store.pendingActions.insert({
        person_id: person.id,
        turn_id: turnId,
        task_id: taskId ?? null,
        tool: tool.name,
        args,
        args_hash: argsHash(args),
        // TOOL-2 requires confirmSummary on an irreversible tool, so this
        // is always there. Stored as the person saw it.
        summary: tool.confirmSummary?.(args) ?? `Confirm ${tool.name}?`,
        code: newCode(),
        status: "pending",
        expires_at: expiresAt.toISOString(),
      })

      await forPerson(person, turnId).record("pending_action_created", {
        actionId: action.id,
        tool: tool.name,
        summary: action.summary,
        expiresAt: action.expires_at,
      })

      await ask(action, person)

      // CONF-1's expiry. A job per action rather than a sweep: the dedupe
      // key makes it exactly once, and it fires when it is due instead of
      // whenever a sweep next looks.
      await jobs.queue({
        kind: EXPIRE_JOB,
        payload: { actionId: action.id },
        runAt: expiresAt,
        dedupeKey: `${EXPIRE_JOB}:${action.id}`,
      })

      return action
    },

    async resolve(input): Promise<Resolution | null> {
      const { person } = input
      const text = input.text?.trim() ?? ""
      const payload = input.payload?.trim() ?? ""

      const parsed = payload === "" ? parsePayload(text) : parsePayload(payload)

      let action: PendingActionRow | null = null
      let verb: Verb = "c"

      if (parsed !== null) {
        verb = parsed.verb
        // The signature is checked before the row is read, so an invalid
        // payload never becomes a database lookup.
        if (!payloadIsValid(parsed, person.id, secret)) {
          await reject(person, "bad_signature", { actionId: parsed.actionId })
          return { kind: "rejected", why: "bad_signature" }
        }
        action = await store.pendingActions.byId(parsed.actionId)
        if (action === null) {
          await reject(person, "no_such_action", { actionId: parsed.actionId })
          return { kind: "rejected", why: "no_such_action" }
        }
      } else if (text.toLowerCase() === CANCEL_WORD) {
        // CONF-8: the word cancel, while something is pending.
        verb = "x"
        action = await store.pendingActions.find({ person_id: person.id, status: "pending" })
        // Nothing pending, so this is an ordinary message about something
        // else. Not a rejection: the brain should see it.
        if (action === null) return null
      } else if (new RegExp(`^\\d{${CODE_DIGITS}}$`).test(text)) {
        // CONF-4: the typed code, matched within this person's own actions,
        // so the same digits from someone else are nothing.
        const open = await store.pendingActions.list(
          { person_id: person.id, status: "pending" },
          { orderBy: "seq" },
        )
        action = open.find((row) => row.code === text) ?? null
        // Four digits that match nothing is a message, not a failed
        // confirmation. It may well be a party size.
        if (action === null) return null
      } else {
        return null
      }

      await forPerson(person).record("confirmation_received", {
        actionId: action.id,
        verb,
        how: parsed !== null ? "button" : verb === "x" ? "word" : "code",
      })

      // CONF-4: the same person who created it.
      if (action.person_id !== person.id) {
        await reject(person, "another_person", { actionId: action.id })
        return { kind: "rejected", why: "another_person", action }
      }

      // CONF-8: a cancel for something that already ran changes nothing.
      if (action.status === "executed") {
        return { kind: "already_done", action }
      }

      if (action.status !== "pending") {
        await reject(person, "not_pending", { actionId: action.id, status: action.status })
        return { kind: "rejected", why: "not_pending", action }
      }

      if (new Date(action.expires_at).getTime() <= clock.now().getTime()) {
        await reject(person, "expired", { actionId: action.id })
        return { kind: "rejected", why: "expired", action }
      }

      // CONF-4: the arguments have not changed since the person saw them.
      if (argsHash(action.args) !== action.args_hash) {
        await reject(person, "arguments_changed", { actionId: action.id })
        return { kind: "rejected", why: "arguments_changed", action }
      }

      if (verb === "x") {
        const [cancelled] = await store.pendingActions.update(
          { id: action.id, status: "pending" },
          { status: "cancelled", decided_at: clock.now().toISOString() },
        )
        // Lost the race to a confirmation that landed first.
        if (cancelled === undefined) {
          const now = await store.pendingActions.byId(action.id)
          return now?.status === "executed"
            ? { kind: "already_done", action: now }
            : { kind: "rejected", why: "not_pending", action: now ?? action }
        }
        return { kind: "cancelled", action: cancelled }
      }

      // CONF-5: claim it. One conditional update from pending to
      // confirmed, so of two taps arriving together exactly one proceeds
      // and the other finds nothing to claim.
      const [claimed] = await store.pendingActions.update(
        { id: action.id, status: "pending" },
        { status: "confirmed", decided_at: clock.now().toISOString() },
      )
      if (claimed === undefined) {
        const now = await store.pendingActions.byId(action.id)
        if (now?.status === "executed") return { kind: "already_done", action: now }
        // CONF-5: the loser of two taps arriving together. A seventh
        // rejection, and the one that proves the helper earns its keep:
        // it is far from the other six and was easy to miss.
        await reject(person, "not_pending", { actionId: action.id, race: true })
        return { kind: "rejected", why: "not_pending", action: now ?? action }
      }

      const tool = toolByName(claimed.tool)
      if (tool === undefined) {
        // The tool was removed between the ask and the answer, which a
        // deploy can do. Failed rather than executed, and the person is
        // told, because the one thing that must not happen is the row
        // sitting there looking like it ran.
        const error = `the tool ${claimed.tool} is no longer registered`
        const [failed] = await store.pendingActions.update(
          { id: claimed.id },
          { status: "failed", error, executed_at: clock.now().toISOString() },
        )
        return { kind: "failed", action: failed ?? claimed, error }
      }

      try {
        const result = await tool.handler(
          tool.parse(claimed.args) as never,
          await options.contextFor(person, claimed),
        )
        const [executed] = await store.pendingActions.update(
          { id: claimed.id },
          {
            status: "executed",
            executed_at: clock.now().toISOString(),
            result: result ?? null,
          },
        )
        await forPerson(person).record("pending_action_executed", {
          actionId: claimed.id,
          tool: claimed.tool,
        })
        await events.about({ personId: person.id }).toolRun({
          tool: claimed.tool,
          risk: tool.risk,
          status: "ok",
          args: claimed.args,
          result,
          step: 0,
          durationMs: 0,
        })
        return { kind: "executed", action: executed ?? claimed, result }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const [failed] = await store.pendingActions.update(
          { id: claimed.id },
          { status: "failed", error: message, executed_at: clock.now().toISOString() },
        )
        await events.about({ personId: person.id }).toolRun({
          tool: claimed.tool,
          risk: tool.risk,
          status: "error",
          args: claimed.args,
          error: message,
          step: 0,
          durationMs: 0,
        })
        return { kind: "failed", action: failed ?? claimed, error: message }
      }
    },

    async expire(actionId: string): Promise<void> {
      // Conditional, so an action confirmed a second before its expiry job
      // ran is not expired out from under the person.
      const [expired] = await store.pendingActions.update(
        { id: actionId, status: "pending" },
        { status: "expired", decided_at: clock.now().toISOString() },
      )
      if (expired === undefined) return

      await events
        .about({
          personId: expired.person_id,
          ...(expired.turn_id !== null ? { turnId: expired.turn_id } : {}),
        })
        .record("pending_action_expired", { actionId, tool: expired.tool })
    },
  }
}
