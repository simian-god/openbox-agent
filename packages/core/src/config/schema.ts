// The shape of an agent's config, as section 19 of the Spec lays it out.
//
// Every object is strict, so a misspelled field is an error rather than a
// setting that silently does nothing.
import { z } from "zod"
import {
  BRAIN_IDS,
  DECISION_MODEL_IDS,
  DECISION_ROUTE_IDS,
  DECISION_ROUTES,
  EMBEDDER_IDS,
  RETRIEVER_IDS,
  TRANSCRIBER_IDS,
} from "./providers.ts"

/** A 24 hour clock time, as config writes it. */
const TIME = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a 24 hour time like 09:00 or 21:30")

/** A calendar date with no time, used by opening hours exceptions. */
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date like 2026-10-20")

const minutesSinceMidnight = (time: string): number => {
  const [hours, minutes] = time.split(":").map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

/** TIME-1, TIME-2: hours are read in the agent's timezone. */
const OPENING_RANGE = z
  .tuple([TIME, TIME])
  .refine(([from, to]) => minutesSinceMidnight(from) < minutesSinceMidnight(to), {
    message: "the range must end after it starts",
  })

const DAY_RANGES = z.array(OPENING_RANGE)

const HOURS = z
  .object({
    mon: DAY_RANGES.optional(),
    tue: DAY_RANGES.optional(),
    wed: DAY_RANGES.optional(),
    thu: DAY_RANGES.optional(),
    fri: DAY_RANGES.optional(),
    sat: DAY_RANGES.optional(),
    sun: DAY_RANGES.optional(),
    exceptions: z
      .array(
        z
          .object({
            date: DATE,
            closed: z.boolean().optional(),
            ranges: DAY_RANGES.optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

/** A real IANA zone, checked against the runtime's own zone table. */
const TIMEZONE = z.string().refine(
  (zone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone })
      return true
    } catch {
      return false
    }
  },
  { message: "must be an IANA timezone like Asia/Kolkata" },
)

const BRAIN_CHOICE = z
  .object({
    id: z.enum(BRAIN_IDS),
    model: z.string().min(1),
  })
  .strict()

const BRAIN = BRAIN_CHOICE.extend({
  fallbacks: z.array(BRAIN_CHOICE).default([]),
}).strict()

/** GATE-2: a band is two floors, and Pass must sit above Confirm. */
const GATE_BAND = z
  .object({
    pass: z.number().min(0).max(1),
    confirm: z.number().min(0).max(1),
  })
  .strict()
  .refine((band) => band.confirm <= band.pass, {
    message: "confirm must not be above pass",
  })

const DECISION_MODEL = z
  .object({
    id: z.enum(DECISION_MODEL_IDS),
    // DM-1: only for a model published on more than one route. Left out,
    // the adapter's own default route is used.
    route: z.enum(DECISION_ROUTE_IDS).optional(),
    // Pins the version. Left out, the adapter's pinned default is used.
    model: z.string().min(1).optional(),
    routeThreshold: z.number().min(0).max(1).default(0.6),
    gateBands: z.record(z.string(), GATE_BAND).default({}),
  })
  .strict()
  .refine((value) => value.route === undefined || DECISION_ROUTES[value.id].length > 0, {
    message: "this decision model has only one route, so route must be left out",
    path: ["route"],
  })
  .refine(
    (value) =>
      value.route === undefined ||
      (DECISION_ROUTES[value.id] as readonly string[]).includes(value.route),
    {
      message: "that route is not one this decision model is published on",
      path: ["route"],
    },
  )

const TRANSCRIBER = z
  .object({
    id: z.enum(TRANSCRIBER_IDS),
    // One OpenRouter adapter reaches 28 speech models, so which one is a
    // config line. Left out, each adapter's own pinned default is used.
    model: z.string().min(1).optional(),
  })
  .strict()

const RETRIEVER = z
  .object({
    id: z.enum(RETRIEVER_IDS),
    embedder: z.enum(EMBEDDER_IDS).nullable().default(null),
  })
  .strict()

/** LIMIT-1 and LIMIT-3. The spend cap is required and has no default. */
const LIMITS = z
  .object({
    messagesPerWindow: z.number().int().positive().default(20),
    windowMinutes: z.number().positive().default(10),
    dailySpendUsd: z.number().min(0),
  })
  .strict()

/** HAND-1, HAND-6 and HAND-7. */
const HANDOVER = z
  .object({
    noOperatorMinutes: z.number().positive().default(10),
    idleMinutes: z.number().positive().default(30),
    /**
     * HAND-6: how often the operators are reminded about a handover
     * nobody has taken, during opening hours.
     *
     * Section 19's example does not list this key. HAND-6 says hourly
     * and marks it a default, and in this core every default is a
     * config field, so it is one.
     */
    alertRepeatMinutes: z.number().positive().default(60),
    wantsHumanThreshold: z.number().min(0).max(1).default(0.8),
  })
  .strict()

const PRICING = z.record(
  z.string(),
  z
    .object({
      inputPerM: z.number().min(0),
      outputPerM: z.number().min(0),
    })
    .strict(),
)

/** BUILTIN-2: a task type's fields, and which of them are required. */
const TASK_TYPE = z
  .object({
    fields: z.record(z.string(), z.enum(["required", "optional"])),
    // BUILTIN-3: how long a task may go without a change before it
    // expires. 24 hours is the Spec's default, and it was required here
    // with no default, which made every task type carry a number the
    // builder had no basis to choose.
    idleHours: z.number().positive().default(24),
  })
  .strict()

export const configSchema = z
  .object({
    name: z.string().min(1),
    mode: z.enum(["development", "production"]),
    timezone: TIMEZONE,
    hours: HOURS,

    brain: BRAIN,
    decisionModel: DECISION_MODEL,
    transcriber: TRANSCRIBER.optional(),
    retriever: RETRIEVER,

    history: z.number().int().positive().default(30),
    burstWindowMs: z.number().int().min(0).default(3000),
    routingMinTools: z.number().int().min(0).default(5),
    // ROUTE-5: how long a step waits for the decision model before
    // carrying on with every tool exposed.
    decisionTimeoutMs: z.number().int().positive().default(3000),
    maxSteps: z.number().int().positive().default(8),

    // LOOP-2: how long a worker owns a person before the claim expires.
    // Long enough that a slow turn never loses it, short enough that a
    // process that dies mid turn frees the person again quickly.
    leaseSeconds: z.number().int().positive().default(60),
    // How often a worker looks in the database for waiting messages. A
    // message received by this process is picked up at once, without
    // waiting for the next look.
    workerPollMs: z.number().int().positive().default(1000),
    // How many different people one process answers at the same time. One
    // person is always one turn at a time, whatever this says. Throughput
    // past this comes from running more processes, not from raising it
    // until the database gives out.
    workerConcurrency: z.number().int().positive().default(4),

    // How hard the outbox tries before it gives up on a message. Five
    // attempts with the wait doubling from a second is about thirty
    // seconds in all. Long enough to ride out a blip, short enough that a
    // reply is never embarrassingly late: in a conversation a very late
    // answer is often worse than none, because the person has already
    // asked someone else.
    sendAttempts: z.number().int().positive().default(5),
    sendBackoffMs: z.number().int().positive().default(1000),

    // A job that throws is tried again, the wait doubling, up to this many
    // times. A job is not a conversation: nobody is waiting on the other
    // end of a retention sweep, so it can afford to be patient where a
    // reply cannot.
    jobAttempts: z.number().int().positive().default(5),
    jobBackoffMs: z.number().int().positive().default(5000),
    // How long after a person's lease has expired before another process
    // takes their half finished turn back. The lease expiring already
    // means renewal stopped for a full lease, so this is the margin on top
    // of that, for a process that was merely stalled rather than dead.
    recoverAfterSeconds: z.number().int().min(0).default(60),
    limits: LIMITS,
    pricing: PRICING.default({}),

    handover: HANDOVER.prefault({}),
    pendingActionMinutes: z.number().positive().default(15),
    // PRO-3: 21:00 to 09:00 unless the config says otherwise. A default
    // rather than optional, because "nothing non urgent goes out in quiet
    // hours" is a promise to the person, and an agent that forgot to
    // write the line should still keep it. An agent that genuinely wants
    // none says so with a range of zero length, like ["09:00", "09:00"].
    quietHours: z.tuple([TIME, TIME]).default(["21:00", "09:00"]),
    taskTypes: z.record(z.string(), TASK_TYPE).default({}),

    // PRIV-1 and PRIV-2: both required, both with no default.
    notice: z.string().trim().min(1),
    retentionDays: z.number().int().positive(),

    builderChannel: z
      .object({
        channel: z.string().min(1),
        channelUserId: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()

/** The config an agent runs on, with every default filled in. */
export type OpenboxConfig = z.output<typeof configSchema>

/** What a builder writes in their config file. */
export type OpenboxConfigInput = z.input<typeof configSchema>
