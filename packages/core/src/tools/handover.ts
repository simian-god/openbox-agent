// Section 10's handover tools: `escalate` for the person's side, and
// `take_over` and `resume` for the operator's.
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
import type { PersonRow, Store } from "../store/index.ts"
import type { Handovers } from "../runtime/handover.ts"
import { defineBuiltinTool, type Tool, type ToolContext } from "./define.ts"
import { personFinder, WHO } from "./operator.ts"

export interface HandoverToolOptions {
  store: Store
  handovers: Handovers
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
  const { store, handovers } = options
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
      "Takes a handover, so you are the one replying to that person. Takes whoever has waited longest unless you name someone.",
    input: z.object(WHO_OPTIONAL),
    risk: "read",
    roles: ["operator"],
    conditions: {
      callWhen: ["An operator has said they are taking a handover, or taking a named person"],
      dontCallWhen: [
        "They are asking what is waiting rather than taking it",
        "They are already the one on it",
      ],
    },
    examples: {
      should: ["take over", "I'll take 919812345678"],
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

  return [escalate, takeOver, resume]
}
