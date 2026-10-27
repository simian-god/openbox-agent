// PRO-1 and PRO-2: the agent speaking first.
//
// Everything else in the core answers a message. A reminder and an outside
// event have nobody waiting at the other end, which changes what has to be
// true of them:
//
//   They have to survive a restart, because the thing that asked for the
//   message is long gone by the time it is due. So a proactive message is
//   a job row (PRO-1), and the job loop's own guarantees carry it: claimed
//   by one process, retried on failure, taken over if that process dies.
//
//   They have to go out exactly once. A job that was claimed and never
//   finished with is taken over, so the handler can genuinely run twice,
//   and the person must not hear the same reminder twice. The outbox key
//   is the job's id, which makes the second send a duplicate the outbox
//   drops rather than a second message.
//
//   They have to be droppable. A person who is blocked, or who is in the
//   middle of a conversation with a colleague, hears nothing from the bot
//   (ROLE-4, and C11's "the bot sends nothing to that person while handed
//   over"). Dropped and recorded, so it is in the trace rather than a
//   mystery.
//
// Two shapes, which PRO-2 names. A fixed message is the builder's own
// words or a template, and nothing reads it, improves it or costs
// anything. A composed message is a turn: the brain is handed a note about
// the event instead of a message from the person, and runs with the same
// tools and the same gate as any other turn, which is the clause that
// keeps a reminder from becoming a way around CONF-1.
//
// PRO-3's send rules, which are the opt out, quiet hours and the channel
// window, are not here. They belong to the outbox, just before a message
// goes out, which is where the Spec puts them and where T7.2 builds them.
import { randomUUID } from "node:crypto"
import type { OpenboxConfig } from "../config/index.ts"
import type { JobRow, PersonRow, Store } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"
import { inQuietHours, quietHoursEnd } from "../time/index.ts"
import type { EventWriter } from "./events.ts"
import type { Jobs } from "./jobs.ts"
import type { Outbox } from "./outbox.ts"

/** The kind every scheduled message and every triggered one is queued as. */
export const PROACTIVE_JOB = "proactive_message"

/** A message in the agent's own words, a template, or one the brain writes. */
export interface ScheduleRequest {
  personId: string
  /** When to send it. The past means now. */
  at: Date
  /** PRO-2: fixed, word for word. */
  text?: string | undefined
  /** PRO-2: fixed, as an approved channel template. */
  template?: { name: string; vars: Record<string, string> } | undefined
  /** PRO-2: composed. What the brain is being asked to say. */
  compose?: string | undefined
  /** PRO-3: quiet hours do not hold an urgent message back. */
  urgent?: boolean | undefined
  /** PRO-1: the same key twice is the same reminder, scheduled once. */
  dedupeKey?: string | undefined
}

/** An outside event, which the brain turns into a message (PRO-2). */
export interface TriggerRequest {
  personId: string
  /** What happened, in the builder's own vocabulary: `order_ready`. */
  event: string
  /** Whatever the brain needs to say something useful about it. */
  data?: Record<string, unknown> | undefined
  urgent?: boolean | undefined
  /** Not in the Spec's signature, but a glue that can fire twice wants it. */
  dedupeKey?: string | undefined
}

/** What a caller gets back: the job, and whether it was already there. */
export interface Scheduled {
  jobId: string
  /** PRO-1: true when the dedupe key had already booked this message. */
  duplicate: boolean
}

/** What became of one proactive job. Recorded, and returned for a test. */
export interface Proacted {
  did: "sent" | "composed" | "silent" | "dropped" | "deferred" | "already" | "gone"
  why?: "blocked" | "handover" | "opted_out" | "quiet_hours" | undefined
}

/** What the job row carries. Read defensively: it came from the database. */
interface Payload {
  personId?: unknown
  ref?: unknown
  urgent?: unknown
  text?: unknown
  template?: unknown
  compose?: unknown
  event?: unknown
  data?: unknown
}

export interface ProactiveOptions {
  config: OpenboxConfig
  store: Store
  clock: Clock
  events: EventWriter
  outbox: Outbox
  jobs: Pick<Jobs, "queue">
  /**
   * PRO-2: runs one turn from a note, under this person's lease.
   *
   * Injected because a turn needs most of what `createAgent` builds, and
   * because the lease is what keeps a reminder from running beside a
   * conversation (LOOP-2). It throws if the person is busy, which is what
   * sends the job back to the queue.
   */
  compose(request: {
    person: PersonRow
    note: string
    key: string
    urgent: boolean
  }): Promise<"composed" | "silent">
  /** C11: the handover this person is in, if they are in one. */
  handoverFor(person: PersonRow): Promise<{ id: string } | undefined>
}

export interface Proactive {
  /** PRO-1: a message at a time. */
  schedule(request: ScheduleRequest): Promise<Scheduled>
  /** PRO-2: a message about something that just happened. */
  trigger(request: TriggerRequest): Promise<Scheduled>
  /** The job handler. Exposed so a test can drive one directly. */
  run(job: JobRow): Promise<Proacted>
}

/**
 * PRO-2: what the brain is given in place of a message from the person.
 *
 * It says plainly that nobody wrote, because the one failure worth
 * designing against is an agent that opens with "you asked about your
 * table" when they did not.
 */
export function noteFor(request: {
  compose?: string | undefined
  event?: string | undefined
  data?: Record<string, unknown> | undefined
}): string {
  const lines = ["Nobody has written to you. You are starting this conversation."]

  if (request.compose !== undefined) {
    lines.push(`What to tell them: ${request.compose}`)
  } else {
    lines.push(`Something has happened that they should hear about: ${request.event}`)
    const entries = Object.entries(request.data ?? {})
    if (entries.length > 0) {
      lines.push("Details:")
      for (const [name, value] of entries) {
        lines.push(`- ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
      }
    }
  }

  lines.push(
    "Write them one short message about it now.",
    "Do not answer a question they did not ask, and do not greet them as if they had just written.",
  )
  return lines.join("\n")
}

/** How a template is written into the conversation (see `store` below). */
export function templateLine(template: { name: string; vars: Record<string, string> }): string {
  const vars = Object.entries(template.vars)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ")
  return vars === "" ? `(template ${template.name})` : `(template ${template.name}: ${vars})`
}

export function createProactive(options: ProactiveOptions): Proactive {
  const { config, store, clock, events, outbox, jobs, compose, handoverFor } = options

  /**
   * The person this is for, or a refusal.
   *
   * Read when the message is asked for rather than when it comes due,
   * because a glue with the wrong id wants to hear about it now and not
   * in six hours from a job that quietly did nothing.
   */
  async function recipient(personId: string): Promise<PersonRow> {
    const person = await store.people.byId(personId)
    if (person === null) throw new Error(`there is no person with id ${personId}`)
    return person
  }

  /**
   * Books the job, and says whether it was already booked.
   *
   * The ref is how it tells. `jobs.queue` hands back the row the dedupe
   * key already had, which is indistinguishable from the row it just
   * wrote unless something in it is ours alone.
   */
  async function book(payload: Record<string, unknown>, at: Date, dedupeKey?: string | undefined) {
    const ref = randomUUID()
    const job = await jobs.queue({
      kind: PROACTIVE_JOB,
      payload: { ...payload, ref },
      runAt: at,
      ...(dedupeKey !== undefined ? { dedupeKey: `${PROACTIVE_JOB}:${dedupeKey}` } : {}),
    })
    return { jobId: job.id, duplicate: (job.payload as Payload).ref !== ref }
  }

  async function schedule(request: ScheduleRequest): Promise<Scheduled> {
    // PRO-2: fixed or composed, and exactly one of them. Two ways to say
    // it is a caller who believes something that is not true about what
    // will be sent, so it is refused rather than resolved.
    const ways = [request.text, request.template, request.compose].filter(
      (way) => way !== undefined,
    )
    if (ways.length !== 1) {
      throw new Error(
        `a scheduled message needs exactly one of text, template or compose, and this one has ${ways.length}`,
      )
    }

    const person = await recipient(request.personId)
    return book(
      {
        personId: person.id,
        ...(request.urgent === true ? { urgent: true } : {}),
        ...(request.text !== undefined ? { text: request.text } : {}),
        ...(request.template !== undefined ? { template: request.template } : {}),
        ...(request.compose !== undefined ? { compose: request.compose } : {}),
      },
      request.at,
      request.dedupeKey,
    )
  }

  async function trigger(request: TriggerRequest): Promise<Scheduled> {
    if (request.event.trim() === "") throw new Error("a trigger needs an event name")

    const person = await recipient(request.personId)
    // Now, through the same job row as a scheduled message. One path, and
    // an event that arrives while the process is restarting is not lost.
    return book(
      {
        personId: person.id,
        event: request.event,
        ...(request.data !== undefined ? { data: request.data } : {}),
        ...(request.urgent === true ? { urgent: true } : {}),
      },
      clock.now(),
      request.dedupeKey,
    )
  }

  /** PRO-2's fixed half: the builder's words, or a template, as they are. */
  async function sendFixed(person: PersonRow, payload: Payload, key: string): Promise<void> {
    const text = typeof payload.text === "string" ? payload.text : undefined
    const template = payload.template as { name: string; vars: Record<string, string> } | undefined

    await outbox.queue({
      personId: person.id,
      kind: "proactive",
      channel: person.channel,
      channelUserId: person.channel_user_id,
      ...(text !== undefined ? { text } : {}),
      ...(template !== undefined ? { template } : {}),
      idempotencyKey: key,
      urgent: payload.urgent === true,
    })

    // Stored as well as sent, because LOOP-7 hands the brain the
    // conversation. A reminder the brain cannot see is a reminder it will
    // send again in its own words five minutes later. A template is
    // written down as a line it can read, since its words live at the
    // channel and never reach us.
    await store.messages.insert({
      person_id: person.id,
      direction: "outbound",
      author: "agent",
      text: text ?? (template === undefined ? "" : templateLine(template)),
      channel: person.channel,
      created_at: clock.now().toISOString(),
    })
  }

  /**
   * The same message again, at a later time, as a new job row.
   *
   * A job cannot be rescheduled: the loop writes `done` over whatever the
   * handler left behind, and a dedupe key cannot be moved. So the way to
   * put something off is to book another one, which is the trick BUILTIN-3
   * and HAND-6 already use. The new row carries no dedupe key, because the
   * key it came with is still held by this row.
   */
  async function rebook(job: JobRow, at: Date): Promise<void> {
    const { ref: _ref, ...rest } = job.payload as Record<string, unknown>
    await jobs.queue({ kind: PROACTIVE_JOB, payload: { ...rest, ref: randomUUID() }, runAt: at })
  }

  async function run(job: JobRow): Promise<Proacted> {
    const payload = job.payload as Payload
    const key = `proactive:${job.id}`

    const record = async (what: Proacted, personId?: string): Promise<Proacted> => {
      await events.about(personId !== undefined ? { personId } : {}).record("job_ran", {
        job: PROACTIVE_JOB,
        did: what.did,
        ...(what.why !== undefined ? { why: what.why } : {}),
      })
      return what
    }

    const person =
      typeof payload.personId === "string" ? await store.people.byId(payload.personId) : null
    // Erased or never there. Nothing to send and nothing waiting will
    // change that, so it is done rather than retried.
    if (person === null) return record({ did: "gone" })

    // Exactly once (C16). The second run of a job whose first run already
    // queued the message stops here, so it costs no brain call and writes
    // no second line into the conversation. The outbox would drop the
    // duplicate send either way; this is what keeps the rest of it from
    // happening twice.
    if ((await store.outbox.find({ idempotency_key: key })) !== null) {
      return record({ did: "already" }, person.id)
    }

    // ROLE-4: a blocked person's messages are stored and never answered,
    // which has to include the ones nobody asked for.
    if (person.blocked) return record({ did: "dropped", why: "blocked" }, person.id)

    // PRO-3's first rule, read here as well as in the outbox. The outbox
    // is where the Spec puts it and where it is enforced, but by then a
    // composed message has already paid for a brain call to write
    // something nobody will ever see.
    if (person.opted_out) return record({ did: "dropped", why: "opted_out" }, person.id)

    // C11: the bot sends nothing to that person while handed over. A
    // reminder is still the bot. Checked here so a composed one costs
    // nothing either. The last moment check belongs in the outbox with
    // PRO-3's rules, which is T7.2.
    if ((await handoverFor(person)) !== undefined) {
      return record({ did: "dropped", why: "handover" }, person.id)
    }

    const composed = typeof payload.compose === "string" || typeof payload.event === "string"
    if (!composed) {
      await sendFixed(person, payload, key)
      return record({ did: "sent" }, person.id)
    }

    // PRO-3's second rule, for a composed message only. The outbox would
    // hold the send until morning on its own, but the words would be last
    // night's: "your table is at 8 tonight" arriving at nine the next
    // day. So the job books itself again for the end of quiet hours and
    // the message gets written then, from what is true then. A fixed
    // message does not go stale, so that one waits in the outbox exactly
    // as PRO-3 describes.
    if (payload.urgent !== true && inQuietHours(config, clock.now())) {
      await rebook(job, quietHoursEnd(config, clock.now()))
      return record({ did: "deferred", why: "quiet_hours" }, person.id)
    }

    const did = await compose({
      person,
      note: noteFor({
        ...(typeof payload.compose === "string" ? { compose: payload.compose } : {}),
        ...(typeof payload.event === "string" ? { event: payload.event } : {}),
        ...(payload.data !== null && typeof payload.data === "object"
          ? { data: payload.data as Record<string, unknown> }
          : {}),
      }),
      key,
      urgent: payload.urgent === true,
    })
    return record({ did }, person.id)
  }

  return { schedule, trigger, run }
}
