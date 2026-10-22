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
// TIME-2 and TIME-4: the zone and hours logic lives in one place, so what
// the brain is told about today matches what a tool decides about it.
import { hoursLine, partsInZone } from "../time/index.ts"

export { partsInZone }

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
  const next = partsInZone(tomorrow, config.timezone)

  const lines = [
    "# Right now",
    `Date: ${date} (${weekday})`,
    `Time: ${time} (${config.timezone})`,
    // TIME-4: tomorrow's date as well as today's, so the brain can say
    // the word "tomorrow" without working out what date it is.
    `Tomorrow: ${next.date} (${next.weekday})`,
    "Never work out a date yourself. Pass the words the person used to the tool.",
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
