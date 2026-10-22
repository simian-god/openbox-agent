// LOOP-7: what the brain is given.
//
// System: the static prompt, then a runtime block.
// Messages: the recent history with this person, then the current batch.
//
// The runtime block carries what changes between turns, so the static
// prompt can stay a fixed string and be hashed for a version (LEARN-2).
import type { OpenboxConfig } from "../config/index.ts"
import type { BrainMessage } from "../providers/brains/types.ts"
import type { MessageRow, PendingActionRow, PersonRow, TaskRow } from "../store/index.ts"

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
type DayKey = (typeof DAY_KEYS)[number]

/** The parts of a date, read in the agent's timezone rather than the server's. */
export function partsInZone(at: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })

  const found: Record<string, string> = {}
  for (const part of formatter.formatToParts(at)) found[part.type] = part.value

  return {
    weekday: found["weekday"] ?? "",
    date: `${found["year"]}-${found["month"]}-${found["day"]}`,
    time: `${found["hour"]}:${found["minute"]}`,
  }
}

/** Which day of the week an instant falls on, in the agent's timezone. */
function dayKeyInZone(at: Date, timezone: string): DayKey {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" })
    .format(at)
    .toLowerCase()
  return (DAY_KEYS.find((key) => key === name) ?? "mon") as DayKey
}

/** The opening hours for one day, as a line a brain can read. */
function hoursLine(config: OpenboxConfig, at: Date): string {
  const { date } = partsInZone(at, config.timezone)
  const exception = config.hours.exceptions?.find((entry) => entry.date === date)

  if (exception?.closed === true) return "closed"

  const ranges = exception?.ranges ?? config.hours[dayKeyInZone(at, config.timezone)]
  if (ranges === undefined || ranges.length === 0) return "closed"

  return ranges.map(([from, to]) => `${from} to ${to}`).join(", ")
}

export interface RuntimeBlockInput {
  config: OpenboxConfig
  person: PersonRow
  now: Date
  /** LOOP-7: this person's open tasks, with the active one marked. */
  tasks?: TaskRow[] | undefined
  /** LOOP-7: what they have been asked to confirm and has not expired. */
  pendingActions?: PendingActionRow[] | undefined
}

/**
 * The runtime block LOOP-7 describes. Facts join it with `remember`, in
 * T4.4.
 *
 * Tasks are listed with what is still missing from each, because that is
 * the one thing the brain must not work out for itself (BUILTIN-2). Said
 * plainly in the block, so a brain that is about to claim a booking is
 * complete has to read the opposite first.
 */
export function buildRuntimeBlock(input: RuntimeBlockInput): string {
  const { config, person, now } = input
  const { weekday, date, time } = partsInZone(now, config.timezone)
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  const lines = [
    "# Right now",
    `Date: ${date} (${weekday})`,
    `Time: ${time} (${config.timezone})`,
    "",
    "# Who you are talking to",
    `Role: ${person.role}`,
    `Channel: ${person.channel}`,
  ]

  if (person.display_name !== null) lines.push(`Name: ${person.display_name}`)
  if (person.language !== null) lines.push(`Language: ${person.language}`)

  lines.push(
    "",
    "# Opening hours",
    `Today: ${hoursLine(config, now)}`,
    `Tomorrow: ${hoursLine(config, tomorrow)}`,
  )

  const tasks = input.tasks ?? []
  if (tasks.length > 0) {
    lines.push("", "# Open tasks")
    for (const task of tasks) {
      const mark = task.status === "active" ? " (active)" : ""
      const fields = Object.entries(task.fields)
        .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
        .join(", ")
      lines.push(`- ${task.type}${mark}, id ${task.id}`)
      lines.push(`  known: ${fields === "" ? "nothing yet" : fields}`)
      lines.push(
        task.missing.length === 0
          ? "  still missing: nothing"
          : `  still missing: ${task.missing.join(", ")}`,
      )
    }
    lines.push(
      "Use update_task to record anything new. What is still missing is worked out",
      "for you: never decide a task is complete yourself.",
    )
  }

  const pending = input.pendingActions ?? []
  if (pending.length > 0) {
    lines.push("", "# Waiting on their confirmation")
    for (const action of pending) {
      lines.push(`- ${action.tool}: ${action.summary}`)
    }
    lines.push("This has not happened yet. Do not say it has.")
  }

  return lines.join("\n")
}

/** The system prompt: the static prompt, then the runtime block. */
export function buildSystem(prompt: string, runtimeBlock: string): string {
  return `${prompt.trim()}\n\n---\n\n${runtimeBlock}`
}

/** A stored message as the brain should see it. */
export function toBrainMessage(row: MessageRow): BrainMessage {
  const text = row.text ?? row.transcript ?? ""
  switch (row.author) {
    case "person":
      return { role: "person", text }
    case "operator":
      return { role: "operator", text }
    case "notice":
      return { role: "notice", text }
    default:
      return { role: "agent", text }
  }
}

/**
 * The history LOOP-7 asks for: the last `history` messages with this
 * person, oldest first, then the current batch.
 */
export function buildMessages(history: MessageRow[], batch: string[]): BrainMessage[] {
  return [
    ...history.map(toBrainMessage),
    ...batch.map((text): BrainMessage => ({ role: "person", text })),
  ]
}
