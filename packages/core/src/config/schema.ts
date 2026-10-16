// The shape of an agent's config, as section 19 of the Spec lays it out.
//
// Every object is strict, so a misspelled field is an error rather than a
// setting that silently does nothing.
import { z } from "zod"
import {
  BRAIN_IDS,
  DECISION_MODEL_IDS,
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
    routeThreshold: z.number().min(0).max(1).default(0.6),
    gateBands: z.record(z.string(), GATE_BAND).default({}),
  })
  .strict()

const TRANSCRIBER = z
  .object({
    id: z.enum(TRANSCRIBER_IDS),
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

/** HAND-1 and HAND-7. */
const HANDOVER = z
  .object({
    noOperatorMinutes: z.number().positive().default(10),
    idleMinutes: z.number().positive().default(30),
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

const TASK_TYPE = z
  .object({
    fields: z.record(z.string(), z.enum(["required", "optional"])),
    idleHours: z.number().positive(),
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
    maxSteps: z.number().int().positive().default(8),
    limits: LIMITS,
    pricing: PRICING.default({}),

    handover: HANDOVER.prefault({}),
    pendingActionMinutes: z.number().positive().default(15),
    quietHours: z.tuple([TIME, TIME]).optional(),
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
