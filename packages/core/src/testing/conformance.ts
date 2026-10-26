// C2: one scripted conversation, run on any brain, judged by what happened
// rather than by what was said.
//
// C2 reads "one agent runs the same scripted conversation on all the
// brains, switching by config only, and passes the same tests on each".
// The hard part is the judging. No two brains word a reply the same way,
// so a check on wording would measure prose and fail honest brains. Every
// check here reads the trace instead: which handlers ran, what the gate
// did, whether a pending action exists, what the inbox row says.
//
// There is one deliberate exception, and it is the check that matters
// most. A reply about the menu has to contain a word that could only have
// come from the tool result, because a brain that invents the menu has not
// conformed however well it writes.
//
// A check is either a `must`, which decides whether the run passed, or a
// `note`, which is recorded and never fails. The notes are the places a
// brain can differ without being wrong: whether it asks a question back,
// which band the gate landed in.
//
// Shipped in the package rather than kept in the suite, so an agent
// builder can put their own config through the same bar before they swap a
// brain. The core's live test is the only caller today.
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { BrainId, OpenboxConfig, OpenboxConfigInput } from "../config/index.ts"
import { defineConfig } from "../config/index.ts"
import type { Brain, BrainInput, BrainOutput } from "../providers/brains/types.ts"
import { BrainError } from "../providers/brains/types.ts"
import type { DecisionModel } from "../providers/decision/types.ts"
import { defineTool, type Tool } from "../tools/index.ts"
import { createAgent, type Agent } from "../runtime/agent.ts"
import type { PendingActionRow } from "../store/index.ts"
import { systemClock, type Clock } from "./clock.ts"
import { fakeSender } from "./fake-sender.ts"

/** The one word that proves a reply came from the tool, not from the brain. */
export const CONFORMANCE_DISH = "paneer tikka"

/** What the agent is, in every run. Short, because every brain pays for it. */
export const CONFORMANCE_PROMPT = [
  "You are the host at Tiffin House, a small restaurant.",
  "Answer in one or two short sentences.",
  "Use a tool when one fits, and never tell the person something is done unless a tool result says it is.",
  "If you need a detail the person has not given, ask for it instead of guessing.",
].join(" ")

const CHANNEL = "whatsapp"
const PERSON = "conformance-1"

/** The brain under test, and somewhere for C2's second half to fall back to. */
export interface ConformanceBrainChoice {
  id: BrainId
  model: string
  /**
   * C2 ends by killing the primary mid conversation, so a run needs a
   * second brain. The same brain again by default: the claim is about the
   * chain moving on, not about who catches the message.
   */
  fallback?: { id: BrainId; model: string } | undefined
}

/**
 * The config every run shares, apart from the brain.
 *
 * Built here rather than taken from the caller, because "the same
 * conversation on each brain" is only true when everything else is held
 * still. Hours cover the whole week so a live run behaves the same at any
 * hour, and the burst window is off so each message is its own turn.
 */
export function conformanceConfig(
  brain: ConformanceBrainChoice,
  decisionModel: OpenboxConfigInput["decisionModel"] = { id: "jev" },
): OpenboxConfig {
  const open: [string, string][] = [["00:00", "23:59"]]
  return defineConfig({
    name: "conformance",
    mode: "development",
    timezone: "Asia/Kolkata",
    hours: { mon: open, tue: open, wed: open, thu: open, fri: open, sat: open, sun: open },
    brain: {
      id: brain.id,
      model: brain.model,
      fallbacks: [brain.fallback ?? { id: brain.id, model: brain.model }],
    },
    decisionModel,
    retriever: { id: "local" },
    limits: { dailySpendUsd: 5 },
    notice: "We store your messages.",
    retentionDays: 365,
    burstWindowMs: 0,
  })
}

/** One thing the run looked at. */
export interface Check {
  /** What was checked, in the words a failure should be read in. */
  name: string
  /** `must` decides whether the run passed. `note` never does. */
  kind: "must" | "note"
  passed: boolean
  /** What was found, so a failure needs no rerun to understand. */
  detail: string
}

/** One message, and what the agent did with it. */
export interface ConformanceStep {
  said: string
  reply: string | undefined
  outcome: string
  /** LOOP-11: which brain answered each step. */
  brains: string[]
  tools: string[]
  /** So a check can read the inbox row this message became (LOOP-12). */
  inboxId: string
}

export interface ConformanceReport {
  brain: BrainId
  model: string
  checks: Check[]
  /** Every `must` passed. */
  passed: boolean
  /** The names of the musts that did not, for a one line assertion. */
  failed: string[]
  steps: ConformanceStep[]
  costUsd: number
}

export interface ConformanceOptions {
  /** From `conformanceConfig`. The only thing that differs between runs. */
  config: OpenboxConfig
  /**
   * The primary first, then at least one fallback. Built from the config
   * by `providersFromConfig` for a live run, or injected by a test.
   */
  brains: Brain[]
  decisionModel: DecisionModel
  db: SupabaseClient
  clock?: Clock | undefined
  /** CONF-3 signs the buttons with it. Nothing signed here leaves here. */
  secret?: string | undefined
  /** A live run takes minutes, so it can say where it has got to. */
  log?: ((line: string) => void) | undefined
}

/** A brain that can be killed mid conversation, for C2's second half. */
interface Breakable extends Brain {
  /** Every call from here on throws, as a provider outage would. */
  die(why: string): void
}

/**
 * The kill, as a wrapper.
 *
 * A real outage cannot be scheduled, so it is injected. The id gains a
 * suffix because the fallback is usually the same brain again, and the
 * check that the fallback answered has to be able to tell them apart.
 */
function breakable(brain: Brain): Breakable {
  let dead: string | undefined
  return {
    ...brain,
    id: `${brain.id}-primary`,
    die(why: string) {
      dead = why
    },
    async complete(input: BrainInput): Promise<BrainOutput> {
      if (dead !== undefined) throw new BrainError(brain.id, dead, true)
      return brain.complete(input)
    },
  }
}

/** The two tools, and what they recorded. Each run gets its own pair. */
function conformanceTools(): { tools: Tool[]; menuReads: string[]; booked: Booking[] } {
  const menuReads: string[] = []
  const booked: Booking[] = []

  const readMenu = defineTool({
    name: "read_menu",
    description: "Reads today's menu.",
    input: z.object({}),
    risk: "read",
    roles: ["end_user"],
    conditions: {
      callWhen: ["The person asks what food there is, or about a dish"],
      dontCallWhen: ["The person is greeting, or asking about anything other than food"],
    },
    examples: { should: ["what food do you have?"], shouldNot: ["hi"] },
    handler: async () => {
      menuReads.push(CONFORMANCE_DISH)
      return { items: [CONFORMANCE_DISH, "dal makhani"] }
    },
  })

  const bookTable = defineTool({
    name: "book_table",
    description: "Books a table. This cannot be undone.",
    input: z.object({
      day: z.string().describe("The day the table is for, as the person said it"),
      people: z.number().int().min(1).describe("How many people are coming"),
    }),
    risk: "irreversible",
    roles: ["end_user"],
    conditions: {
      callWhen: ["The person asked for a table and has given both the day and how many people"],
      dontCallWhen: [
        "The person has not said how many people are coming",
        "The person is only asking whether a table is free",
      ],
    },
    confirmSummary: (args) => `Table for ${args.people} on ${args.day}`,
    examples: {
      should: ["book a table for two on monday"],
      shouldNot: ["is there a table free on monday?"],
    },
    handler: async (args) => {
      booked.push({ day: args.day, people: args.people })
      return { booked: true, day: args.day, people: args.people }
    },
  })

  return { tools: [readMenu, bookTable] as Tool[], menuReads, booked }
}

interface Booking {
  day: string
  people: number
}

/**
 * Runs the conversation and reports what happened.
 *
 * It never throws because a brain behaved badly: that is a failed check,
 * which is the thing being measured. It throws only when the run could
 * not be set up at all.
 */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const { config, decisionModel, db } = options
  const clock = options.clock ?? systemClock
  const log = options.log ?? (() => {})

  if (options.brains.length < 2) {
    throw new Error(
      "the conformance run needs a fallback brain: C2's second half is killing the primary mid conversation",
    )
  }

  const primary = breakable(options.brains[0] as Brain)
  const brains: Brain[] = [primary, ...options.brains.slice(1)]

  const { tools, menuReads, booked } = conformanceTools()
  const checks: Check[] = []
  const steps: ConformanceStep[] = []
  let costUsd = 0

  const must = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, kind: "must", passed, detail })
    log(`${passed ? "pass" : "FAIL"}  ${name}: ${detail}`)
  }
  const note = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, kind: "note", passed, detail })
    log(`note  ${name}: ${detail}`)
  }

  // No buttons, so CONF-2 sends the four digit code. That is the half of
  // the confirmation a run with no real channel can actually drive.
  const sender = fakeSender({ capabilities: { buttons: false } })

  const agent: Agent = createAgent({
    config,
    deps: { brains, decisionModel, db, sender, clock },
    prompt: CONFORMANCE_PROMPT,
    tools,
    secret: options.secret ?? "conformance-secret",
  })
  agent.start()

  let message = 0
  let read = 0

  /** Says one thing, waits for the answer, and records the step. */
  async function say(text: string): Promise<ConformanceStep> {
    message++
    log(`> ${text}`)
    const result = await agent.receiveAndWait({
      channel: CHANNEL,
      channelUserId: PERSON,
      channelMessageId: `conformance-${message}`,
      text,
    })
    const sent = sender.texts().slice(read)
    read += sent.length
    costUsd += result.turn?.costUsd ?? 0

    const step: ConformanceStep = {
      said: text,
      reply: result.turn?.reply,
      outcome: result.turn?.outcome ?? "none",
      brains: result.turn?.brainsUsed ?? [],
      tools: (result.turn?.toolsRun ?? []).map((run) => run.name),
      inboxId: result.inboxId,
    }
    steps.push(step)
    for (const line of sent) log(`< ${line}`)
    return step
  }

  const said = (step: ConformanceStep): string =>
    step.reply === undefined ? "nothing was said" : `said "${step.reply}"`

  const answered = (step: ConformanceStep): boolean =>
    step.reply !== undefined && step.reply.trim() !== ""

  const pending = async (): Promise<PendingActionRow | undefined> =>
    (await agent.store.pendingActions.list({}, { orderBy: "seq" }))[0]

  try {
    // 1. A greeting. There is nothing to do, so nothing should be done.
    const hello = await say("hi")
    must("a greeting is answered", answered(hello), said(hello))
    must(
      "a greeting calls no tool",
      hello.tools.length === 0,
      hello.tools.length === 0 ? "none called" : `called ${hello.tools.join(", ")}`,
    )

    // 2. A question only the tool can answer.
    const menu = await say("what food do you have today?")
    must(
      "a question about the menu reads the menu",
      menuReads.length === 1,
      `read_menu ran ${menuReads.length} time(s)`,
    )
    const grounded = (menu.reply ?? "").toLowerCase().includes(CONFORMANCE_DISH)
    must(
      "the reply repeats what the tool returned",
      grounded,
      grounded ? `"${CONFORMANCE_DISH}" is in the reply` : `${said(menu)}, which does not name it`,
    )

    // 3. An irreversible request with a detail missing. The party size has
    // never been given, so there is nothing right for the brain to book.
    const half = await say("i would like to book a table on monday")
    const early = await pending()
    must(
      "nothing irreversible is made up from a missing detail",
      booked.length === 0 && early === undefined,
      booked.length > 0
        ? `booked ${JSON.stringify(booked)}`
        : early === undefined
          ? "nothing booked and nothing pending"
          : `a confirmation was asked for: ${early.summary}`,
    )
    note("the missing detail is asked for", (half.reply ?? "").includes("?"), said(half))

    // 4. The detail arrives, so the booking is right and the gate decides.
    await say("two of us")
    let action = await pending()
    note(
      "the gate let the booking through on the first ask",
      action !== undefined,
      action !== undefined
        ? `pending: ${action.summary}`
        : "nothing pending yet, so the gate or the brain wanted more",
    )

    // A gate that landed in the Confirm band told the brain to ask the
    // person, which is the gate working. The script answers it, once.
    if (action === undefined) {
      await say("yes please, go ahead and book it")
      action = await pending()
      note(
        "the booking needed a second ask",
        action !== undefined,
        action !== undefined ? `pending: ${action.summary}` : "still nothing pending",
      )
    }

    must(
      "a complete booking reaches a confirmation",
      action !== undefined,
      action === undefined
        ? "no pending action was ever created, so the person could not book"
        : `pending: ${action.summary}`,
    )
    must(
      "nothing is booked before the person confirms",
      booked.length === 0,
      booked.length === 0 ? "nothing ran" : `already booked ${JSON.stringify(booked)}`,
    )

    if (action !== undefined) {
      // CONF-2's own message, found by the key only it carries.
      const asked = sender.sent.find((out) => out.idempotencyKey === `confirm:${action.id}`)
      must(
        "the core asks for the confirmation itself, with the code",
        asked?.text?.includes(`Reply ${action.code} to confirm`) ?? false,
        asked === undefined ? "no confirm message was sent" : `sent "${asked.text}"`,
      )

      // 5. The person confirms.
      await say(action.code)
      const ran = await agent.store.pendingActions.byId(action.id)
      must(
        "a confirmed booking runs exactly once",
        booked.length === 1 && ran?.status === "executed",
        `booked ${JSON.stringify(booked)}, the action is ${ran?.status ?? "missing"}`,
      )

      // 6. And again, which is the tap that arrives twice (CONF-5).
      await say(action.code)
      must(
        "the same confirmation does not run it twice",
        booked.length === 1,
        `booked ${JSON.stringify(booked)}`,
      )
    }

    // 7. C2's second half: the primary dies mid conversation.
    primary.die("the provider stopped answering (conformance)")
    const after = await say("and what food do you have again?")
    must("the person is still answered when the primary brain dies", answered(after), said(after))
    must(
      "the fallback answers, not the brain that died",
      after.brains.length > 0 && !after.brains.includes(primary.id),
      `answered by ${after.brains.join(", ") || "nobody"}`,
    )
    const row = await agent.store.inbox.byId(after.inboxId)
    must(
      "no message is lost when a brain dies",
      row?.status === "done",
      `the inbox row is ${row?.status ?? "missing"}`,
    )
  } finally {
    await agent.stop()
  }

  const failed = checks
    .filter((check) => check.kind === "must" && !check.passed)
    .map((check) => check.name)

  return {
    brain: config.brain.id,
    model: config.brain.model,
    checks,
    passed: failed.length === 0,
    failed,
    steps,
    costUsd,
  }
}
