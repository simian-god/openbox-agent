// BUILTIN-2 and BUILTIN-3: the four task tools, and the rules the core
// keeps rather than trusting the brain with.
//
// One rule matters more than the rest. `missing` is computed here, from the
// task type in config, every single time the fields change. The brain never
// writes it and cannot. A brain that could set `missing` to nothing would
// eventually do exactly that, because finishing is what it is trying to
// do, and then a booking with no date would look complete.
//
// The other three tools exist so a conversation can survive an
// interruption. A person asks about parking in the middle of giving their
// party size, and the task is what remembers where they were.
import { z } from "zod"
import type { OpenboxConfig } from "../config/index.ts"
import type { Store, TaskRow, PersonRow } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"
import { defineBuiltinTool, type Tool, type ToolContext } from "./define.ts"

/** The job that expires an idle task (BUILTIN-3). */
export const TASK_EXPIRE_JOB = "task_expire"

/** What a task tool needs that `ToolContext` does not carry. */
export interface TaskToolOptions {
  config: OpenboxConfig
  store: Store
  clock: Clock
  /**
   * BUILTIN-3 and CONF-6: told when a task's fields change or it closes,
   * so the pending action on it can be cancelled. Absent for an agent with
   * no irreversible tools, which can have no pending actions either.
   */
  onTaskChanged?: ((task: TaskRow, why: string) => Promise<void>) | undefined
  /** BUILTIN-3: schedules the idle expiry. */
  scheduleExpiry?: ((task: TaskRow) => Promise<void>) | undefined
}

/**
 * BUILTIN-2: the required fields of this type that are not filled in.
 *
 * A field counts as filled when it is present and is not null, undefined
 * or an empty string. A brain that sets a date to "" has not found out the
 * date, and treating that as filled is how a task completes with a hole in
 * it.
 */
export function missingFields(
  config: OpenboxConfig,
  type: string,
  fields: Record<string, unknown>,
): string[] {
  const declared = config.taskTypes[type]
  if (declared === undefined) return []

  return Object.entries(declared.fields)
    .filter(([, need]) => need === "required")
    .filter(([name]) => {
      const value = fields[name]
      return value === undefined || value === null || value === ""
    })
    .map(([name]) => name)
    .sort()
}

/** The task types this agent declares, for an error a brain can act on. */
const typeList = (config: OpenboxConfig): string => {
  const names = Object.keys(config.taskTypes)
  return names.length === 0 ? "none are declared in config" : names.join(", ")
}

/** How a task reads back to the brain. Compact: it is sent every turn. */
export function describeTask(task: TaskRow): Record<string, unknown> {
  return {
    id: task.id,
    type: task.type,
    status: task.status,
    fields: task.fields,
    missing: task.missing,
  }
}

/** Raised by a task tool when the brain asked for something impossible. */
class TaskRefused extends Error {}

export function taskTools(options: TaskToolOptions): Tool[] {
  const { config, store, clock } = options

  const person = (ctx: ToolContext): string => ctx.person.id

  const idleHours = (type: string): number => config.taskTypes[type]?.idleHours ?? 24

  const expiryFor = (type: string): Date =>
    new Date(clock.now().getTime() + idleHours(type) * 60 * 60 * 1000)

  /** Everything still open for this person, newest first. */
  const openFor = (personId: string): Promise<TaskRow[]> =>
    store.tasks
      .list({ person_id: personId }, { orderBy: "seq", ascending: false })
      .then((rows) => rows.filter((row) => row.status === "open" || row.status === "active"))

  /** One task of this person's, by id, or a refusal naming what is open. */
  async function mine(personId: string, taskId: string): Promise<TaskRow> {
    const task = await store.tasks.byId(taskId)
    // Scoped by person as well as by agent: a task id from another
    // conversation is not this person's to touch.
    if (task === null || task.person_id !== personId) {
      const open = await openFor(personId)
      throw new TaskRefused(
        open.length === 0
          ? `There is no task ${taskId}, and this person has none open.`
          : `There is no task ${taskId} for this person. Their open tasks are: ${open
              .map((row) => `${row.id} (${row.type})`)
              .join(", ")}.`,
      )
    }
    return task
  }

  /** Makes this task the active one, and the others merely open. */
  async function makeActive(personId: string, taskId: string): Promise<void> {
    const open = await openFor(personId)
    for (const task of open) {
      const want = task.id === taskId ? "active" : "open"
      if (task.status !== want) {
        await store.tasks.update({ id: task.id }, { status: want })
      }
    }
  }

  /** Writes fields and recomputes `missing`. The only path that may. */
  async function writeFields(
    task: TaskRow,
    fields: Record<string, unknown>,
    why: string,
  ): Promise<TaskRow> {
    const merged = { ...task.fields, ...fields }
    const expiresAt = expiryFor(task.type)

    const [updated] = await store.tasks.update(
      { id: task.id },
      {
        fields: merged,
        missing: missingFields(config, task.type, merged),
        // BUILTIN-3: any change pushes the idle expiry out.
        expires_at: expiresAt.toISOString(),
        updated_at: clock.now().toISOString(),
      },
    )
    const row = updated ?? task

    // CONF-6: the brain changing a task's fields cancels the pending
    // action on it. The person agreed to what they were shown, and this is
    // no longer what they were shown.
    if (Object.keys(fields).length > 0) await options.onTaskChanged?.(row, why)
    await options.scheduleExpiry?.(row)
    return row
  }

  const refusing =
    <T>(run: (args: T, ctx: ToolContext) => Promise<unknown>) =>
    async (args: T, ctx: ToolContext): Promise<unknown> => {
      try {
        return await run(args, ctx)
      } catch (error) {
        // A refusal is an answer, not a crash: LOOP-8 step 6 hands a tool
        // error back to the brain, and these are all things a brain can
        // put right on the next step.
        if (error instanceof TaskRefused) return { ok: false, error: error.message }
        throw error
      }
    }

  const startTask = defineBuiltinTool({
    name: "start_task",
    description:
      "Opens a task of a declared type, with any fields already known, and makes it the active task.",
    input: z.object({
      type: z.string().min(1),
      fields: z.record(z.string(), z.unknown()).default({}),
    }),
    risk: "read",
    roles: ["end_user"],
    conditions: {
      callWhen: [
        "The person has started something that takes more than one message, such as a booking",
        "There is no open task of that type for what they are asking about",
      ],
      dontCallWhen: [
        "A task of that type is already open for this request. Use update_task instead",
        "The person asked a single question that can be answered in one reply",
      ],
    },
    examples: {
      should: ["i want to book a table", "can you take an order for delivery"],
      shouldNot: ["what time do you close?", "where are you?"],
    },
    handler: refusing(async (args: { type: string; fields: Record<string, unknown> }, ctx) => {
      if (config.taskTypes[args.type] === undefined) {
        throw new TaskRefused(
          `There is no task type "${args.type}". The types this agent has are: ${typeList(config)}.`,
        )
      }

      const personId = person(ctx)
      const fields = args.fields
      const task = await store.tasks.insert({
        person_id: personId,
        type: args.type,
        fields,
        missing: missingFields(config, args.type, fields),
        status: "active",
        expires_at: expiryFor(args.type).toISOString(),
        updated_at: clock.now().toISOString(),
      })

      // It becomes the active task, so whatever was active is not.
      await makeActive(personId, task.id)
      await options.scheduleExpiry?.(task)

      return { ok: true, task: describeTask(task) }
    }),
  })

  const updateTask = defineBuiltinTool({
    name: "update_task",
    description:
      "Sets fields on a task. The core works out what is still missing; never say a task is complete yourself.",
    input: z.object({
      taskId: z.string().min(1),
      fields: z.record(z.string(), z.unknown()),
    }),
    risk: "read",
    roles: ["end_user"],
    conditions: {
      callWhen: [
        "The person has given a detail that belongs to an open task",
        "A detail they gave earlier has changed",
      ],
      dontCallWhen: [
        "There is no open task yet. Use start_task",
        "The detail belongs to no field of that task type",
      ],
    },
    examples: {
      should: ["four of us", "make it 8pm instead", "my name is Asha"],
      shouldNot: ["what is on the menu?", "thanks, bye"],
    },
    handler: refusing(async (args: { taskId: string; fields: Record<string, unknown> }, ctx) => {
      const task = await mine(person(ctx), args.taskId)
      if (task.status !== "open" && task.status !== "active") {
        throw new TaskRefused(`That task is ${task.status}, so it cannot be changed.`)
      }

      const declared = config.taskTypes[task.type]
      const unknown = Object.keys(args.fields).filter(
        (name) => declared?.fields[name] === undefined,
      )
      if (unknown.length > 0) {
        // Refused rather than stored. A field the type does not declare is
        // one `missing` can never account for, so storing it would make a
        // task look fuller than it is.
        throw new TaskRefused(
          `The task type "${task.type}" has no field ${unknown.join(", ")}. Its fields are: ${Object.keys(
            declared?.fields ?? {},
          ).join(", ")}.`,
        )
      }

      const updated = await writeFields(task, args.fields, "the task's fields changed")
      return { ok: true, task: describeTask(updated) }
    }),
  })

  const switchTask = defineBuiltinTool({
    name: "switch_task",
    description: "Makes another of the person's open tasks the active one.",
    input: z.object({ taskId: z.string().min(1) }),
    risk: "read",
    roles: ["end_user"],
    conditions: {
      callWhen: [
        "The person has gone back to something they started earlier",
        "They have several tasks open and the one they mean is not the active one",
      ],
      dontCallWhen: [
        "They only have one task open",
        "They are starting something new. Use start_task",
      ],
    },
    examples: {
      should: ["actually, back to the booking", "about that order from earlier"],
      shouldNot: ["i want to book a table", "four of us"],
    },
    handler: refusing(async (args: { taskId: string }, ctx) => {
      const personId = person(ctx)
      const task = await mine(personId, args.taskId)
      if (task.status !== "open" && task.status !== "active") {
        throw new TaskRefused(`That task is ${task.status}, so it cannot be made active.`)
      }

      await makeActive(personId, task.id)
      const now = await store.tasks.byId(task.id)
      return { ok: true, task: describeTask(now ?? task) }
    }),
  })

  const closeTask = defineBuiltinTool({
    name: "close_task",
    description: "Marks a task done or cancelled.",
    input: z.object({
      taskId: z.string().min(1),
      outcome: z.enum(["done", "cancelled"]),
    }),
    risk: "read",
    roles: ["end_user"],
    conditions: {
      callWhen: [
        "What the task was for has been completed",
        "The person has said they no longer want it",
      ],
      dontCallWhen: [
        "Fields are still missing and the person has not given up on it",
        "The task is already done or cancelled",
      ],
    },
    examples: {
      should: ["that is all sorted thanks", "forget the booking, we will come another time"],
      shouldNot: ["four of us", "what time do you open?"],
    },
    handler: refusing(async (args: { taskId: string; outcome: "done" | "cancelled" }, ctx) => {
      const task = await mine(person(ctx), args.taskId)
      if (task.status !== "open" && task.status !== "active") {
        throw new TaskRefused(`That task is already ${task.status}.`)
      }

      const [closed] = await store.tasks.update(
        { id: task.id, person_id: task.person_id },
        {
          status: args.outcome,
          closed_at: clock.now().toISOString(),
          updated_at: clock.now().toISOString(),
        },
      )
      // BUILTIN-3: closing a task takes its pending action with it. An
      // action for a booking that has been cancelled must not still be
      // sitting there waiting to be tapped.
      await options.onTaskChanged?.(closed ?? task, `the task was ${args.outcome}`)
      return { ok: true, task: describeTask(closed ?? task) }
    }),
  })

  return [startTask, updateTask, switchTask, closeTask]
}

/** LOOP-7: this person's open tasks, with the active one marked. */
export async function openTasks(store: Store, person: PersonRow): Promise<TaskRow[]> {
  const rows = await store.tasks.list({ person_id: person.id }, { orderBy: "seq" })
  return rows.filter((row) => row.status === "open" || row.status === "active")
}
