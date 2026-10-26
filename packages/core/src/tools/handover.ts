// Section 10's handover tools: `escalate` for the person's side, and
// `take_over`, `resume` and `list_handovers` for the operator's.
//
// Three tools, and almost no logic: all three hand straight to the
// handover module, because the rules about states and races belong in one
// place (HAND-1 to HAND-3, HAND-7) and a tool that reimplemented any of
// them would be a second answer to the same question.
//
// What is here instead is what the brain needs to call them correctly: an
// `escalate` that will not fire on a vague complaint, and a `take_over`
// that says plainly when somebody else already has it.
import { z } from "zod"
import type { HandoverRow, PersonRow, Store } from "../store/index.ts"
import { nameOf, type Handovers } from "../runtime/handover.ts"
import type { Clock } from "../testing/clock.ts"
import { defineBuiltinTool, type Tool, type ToolContext } from "./define.ts"
import { personFinder, WHO } from "./operator.ts"

export interface HandoverToolOptions {
  store: Store
  handovers: Handovers
  /** TIME-1: how long something has waited, by the injected clock. */
  clock: Clock
}

/** Naming a person is optional for an operator: most of the time it is obvious. */
const WHO_OPTIONAL = {
  user_id: z
    .string()
    .min(1)
    .optional()
    .describe("Only when you mean a particular person rather than the one who has waited longest"),
  channel: WHO.channel,
}

export function handoverTools(options: HandoverToolOptions): Tool[] {
  const { store, handovers, clock } = options
  const find = personFinder(store)

  /** An operator's optional person argument, resolved. */
  async function named(
    args: { user_id?: string | undefined; channel?: string | undefined },
    ctx: ToolContext,
  ): Promise<{ person?: PersonRow } | { error: string }> {
    if (args.user_id === undefined) return {}
    const found = await find(
      {
        user_id: args.user_id,
        ...(args.channel !== undefined ? { channel: args.channel } : {}),
      },
      ctx,
    )
    return "error" in found ? { error: found.error } : { person: found.person }
  }

  const escalate = defineBuiltinTool({
    name: "escalate",
    description:
      "Hands this conversation to a human colleague. The person is told somebody will reply, and every operator is alerted.",
    input: z.object({
      why: z
        .string()
        .min(1)
        .describe("Why a person is needed, in one line, for the operator who picks it up"),
    }),
    risk: "read",
    roles: ["end_user"],
    conditions: {
      callWhen: [
        "The person has asked for a human, a manager or somebody to call them",
        "They are upset and nothing you can do will settle it",
        "What they need is outside everything you can do, and leaving it would cost them",
      ],
      dontCallWhen: [
        "You can still answer, or a tool can. Try that first",
        "You have already handed this conversation over. It is still with a colleague",
        "They are only asking a question you have not been given the answer to. Say you will find out",
      ],
    },
    examples: {
      should: ["let me talk to a person", "this is the third time, get me your manager"],
      shouldNot: ["what are your hours?", "can I change my booking?"],
    },
    handler: async (args: { why: string }, ctx: ToolContext) => {
      const person = await store.people.byId(ctx.person.id)
      if (person === null) return { ok: false, error: "This person has no record to hand over." }

      const { handover, opened } = await handovers.open({
        person,
        reason: "escalate",
        detail: args.why,
        ...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
      })

      // HAND-2: the core sends the person's message, not the brain. The
      // brain is told so it does not send a second one of its own.
      return opened
        ? {
            ok: true,
            handedOver: true,
            note: "They have been told a colleague will reply. Do not tell them again, and do not promise when.",
          }
        : {
            ok: true,
            handedOver: false,
            note: `This conversation was already handed over, ${
              handover.status === "active"
                ? "and a colleague is on it"
                : "and nobody has taken it yet"
            }. Say nothing new about it.`,
          }
    },
  })

  const takeOver = defineBuiltinTool({
    name: "take_over",
    description:
      "Takes a handover, so you are the one replying to that person. Takes whoever has waited longest unless you name someone. Naming one you already hold moves you to it.",
    input: z.object(WHO_OPTIONAL),
    risk: "read",
    roles: ["operator"],
    conditions: {
      callWhen: [
        "An operator has said they are taking a handover, or taking a named person",
        // HAND-4: an operator holding two conversations has to be able
        // to say which one they are typing into, and section 10 has no
        // other tool for it.
        "An operator holding more than one has said which of them they are on now",
      ],
      dontCallWhen: [
        "They are asking what is waiting rather than taking it",
        "They are already on that one and have not asked to move",
      ],
    },
    examples: {
      should: ["take over", "I'll take 919812345678", "back to 919812345678"],
      shouldNot: ["what is waiting?", "give them back to the bot"],
    },
    handler: async (
      args: { user_id?: string | undefined; channel?: string | undefined },
      ctx: ToolContext,
    ) => {
      const who = await named(args, ctx)
      if ("error" in who) return { ok: false, error: who.error }

      const operator = await store.people.byId(ctx.person.id)
      if (operator === null) return { ok: false, error: "You have no record on this agent." }

      const taken = await handovers.takeOver({
        operator,
        ...(who.person !== undefined ? { person: who.person } : {}),
      })

      if (taken.kind === "none") {
        return {
          ok: false,
          error:
            args.user_id === undefined
              ? "Nothing is waiting to be taken."
              : `${args.user_id} is not in a handover.`,
        }
      }
      if (taken.kind === "already_taken") {
        return {
          ok: false,
          error: `That handover is already ${
            taken.by === null
              ? "taken"
              : `with ${taken.by.display_name ?? taken.by.channel_user_id}`
          }.`,
        }
      }
      return { ok: true, taken: true, handoverId: taken.handover.id }
    },
  })

  const resume = defineBuiltinTool({
    name: "resume",
    description: "Gives a person back to the agent, ending the handover.",
    input: z.object(WHO_OPTIONAL),
    risk: "read",
    roles: ["operator"],
    conditions: {
      callWhen: ["An operator has said they are done with a handover and the agent can have it"],
      dontCallWhen: [
        "They are still dealing with it",
        "They want the person blocked instead. That is block",
      ],
    },
    examples: {
      should: ["done, back to the bot", "resume 919812345678"],
      shouldNot: ["take over", "block them"],
    },
    handler: async (
      args: { user_id?: string | undefined; channel?: string | undefined },
      ctx: ToolContext,
    ) => {
      const who = await named(args, ctx)
      if ("error" in who) return { ok: false, error: who.error }

      const operator = await store.people.byId(ctx.person.id)
      if (operator === null) return { ok: false, error: "You have no record on this agent." }

      const done = await handovers.resume({
        operator,
        ...(who.person !== undefined ? { person: who.person } : {}),
      })

      return done.kind === "resumed"
        ? { ok: true, resumed: true, handoverId: done.handover.id }
        : {
            ok: false,
            error:
              args.user_id === undefined
                ? "You are not on a handover, so there is nothing to give back."
                : `${args.user_id} is not in a handover you can end.`,
          }
    },
  })

  /**
   * Section 10's `list_handovers`, which is what makes focus usable: an
   * operator cannot say which conversation they are on without seeing
   * what there is. Read only, and the one operator tool that names
   * nobody, so it cannot be called wrongly.
   */
  const list = defineBuiltinTool({
    name: "list_handovers",
    description:
      "Lists the handovers that are open: who they are from, why, how long they have waited, and who is on each.",
    input: z.object({}),
    risk: "read",
    roles: ["operator"],
    conditions: {
      callWhen: [
        "An operator has asked what is waiting, what is open, or who is on what",
        "You are about to tell an operator about a handover and do not have it in front of you",
      ],
      dontCallWhen: [
        "They have told you to take one. That is take_over, which takes the longest waiting on its own",
      ],
    },
    examples: {
      should: ["what is waiting?", "who is on what?"],
      shouldNot: ["take over", "block 919812345678"],
    },
    handler: async (_args: unknown, ctx: ToolContext) => {
      const open = (await store.handovers.list({}, { orderBy: "seq" })).filter(
        (row: HandoverRow) => row.status !== "closed",
      )

      const rows = []
      for (const row of open) {
        const person = await store.people.byId(row.person_id)
        const holder = row.operator_id === null ? null : await store.people.byId(row.operator_id)
        rows.push({
          who: person === null ? row.person_id : nameOf(person),
          user_id: person?.channel_user_id ?? null,
          status: row.status,
          reason: row.reason,
          waiting_minutes: Math.floor(
            (clock.now().getTime() - new Date(row.opened_at).getTime()) / 60_000,
          ),
          // Said as `you` rather than as a name, because an operator
          // reading a list of names has to find their own in it.
          with:
            holder === null ? "nobody yet" : holder.id === ctx.person.id ? "you" : nameOf(holder),
        })
      }

      return { ok: true, open: rows.length, handovers: rows }
    },
  })

  return [escalate, takeOver, resume, list]
}
