// Section 10: `block`, `unblock` and `flag`, the three operator tools that
// need nothing else built first.
//
// ROLE-3 is what makes these safe to ship: they are declared for the
// operator role, so an end user is never offered them, and a call to a
// tool the role cannot use is rejected like an unknown tool. Nothing in a
// message can change a role (ROLE-1), and only the builder makes an
// operator (ROLE-2), so the whole chain rests on the database rather than
// on anything the brain reads.
//
// All three are `read`, which looks wrong and is the same call the core
// already makes for `remember` and `start_task`: BUILTIN-1 says only
// `erase_person` is gated, and risk is what the gate reads. Nothing here
// reaches outside the agent. Blocking changes how this agent treats a
// person, it does not take their money or book them a table, and the
// operator asking for it was put there by the builder.
import { z } from "zod"
import type { PersonRow, Store } from "../store/index.ts"
import type { EventWriter } from "../runtime/events.ts"
import { defineBuiltinTool, type Tool, type ToolContext } from "./define.ts"

export interface OperatorToolOptions {
  store: Store
  /** LEARN-1: where `flag` writes. `noEvents()` for a test that ignores them. */
  events: EventWriter
}

/** The two fields all three take: who, and on which channel. */
const WHO = {
  user_id: z
    .string()
    .min(1)
    .describe("Their id on the channel, which on WhatsApp is their phone number"),
  channel: z
    .string()
    .min(1)
    .optional()
    .describe("Only when they are on a different channel from you"),
}

export function operatorTools(options: OperatorToolOptions): Tool[] {
  const { store, events } = options

  /**
   * The person an operator named, or why there is nobody to act on.
   *
   * The channel defaults to the operator's own, because an operator on
   * WhatsApp saying "block 9812345678" means the WhatsApp person, and
   * making them say so every time is how a tool gets called wrongly.
   *
   * Nothing is created here. A name that has never written is a mistake
   * worth reporting, not a new person to block.
   */
  async function find(
    args: { user_id: string; channel?: string | undefined },
    ctx: ToolContext,
  ): Promise<{ person: PersonRow } | { error: string }> {
    const channel = args.channel ?? ctx.person.channel
    const person = await store.people.find({ channel, channel_user_id: args.user_id })

    if (person === null) {
      return {
        error: `Nobody with the id ${args.user_id} has ever written on ${channel}, so there is nobody to act on. Check the id.`,
      }
    }
    return { person }
  }

  const block = defineBuiltinTool({
    name: "block",
    description:
      "Blocks a person, so their messages are stored and never answered. Reversible with unblock.",
    input: z.object({
      ...WHO,
      why: z
        .string()
        .optional()
        .describe("The operator's reason, kept with the record of this call"),
    }),
    risk: "read",
    roles: ["operator"],
    conditions: {
      callWhen: ["An operator has asked you to block a particular person, and has said which one"],
      dontCallWhen: [
        "The operator is complaining about someone without asking for them to be blocked",
        "You are not sure which person they mean. Ask",
        "They asked you to stop replying to someone for now. That is a handover, not a block",
      ],
    },
    examples: {
      should: ["block 919812345678", "block that number, they are abusive"],
      shouldNot: ["this customer is being difficult", "stop answering them for a bit"],
    },
    handler: async (
      args: { user_id: string; channel?: string | undefined; why?: string | undefined },
      ctx: ToolContext,
    ) => {
      const found = await find(args, ctx)
      if ("error" in found) return { ok: false, error: found.error }
      const { person } = found

      // ROLE-2: operators are made by the builder, so an agent must not be
      // able to lock its own operators out of it, by mistake or by being
      // talked into it.
      if (person.role === "operator") {
        return {
          ok: false,
          error: `${args.user_id} is an operator, and an operator cannot be blocked. Removing an operator is the builder's job, not the agent's.`,
        }
      }

      if (person.blocked) {
        return { ok: true, changed: false, blocked: true, note: "They were already blocked." }
      }

      await store.people.update({ id: person.id }, { blocked: true })
      return { ok: true, changed: true, blocked: true, who: person.channel_user_id }
    },
  })

  const unblock = defineBuiltinTool({
    name: "unblock",
    description: "Unblocks a person, so the agent answers them again.",
    input: z.object(WHO),
    risk: "read",
    roles: ["operator"],
    conditions: {
      callWhen: ["An operator has asked you to unblock a particular person"],
      dontCallWhen: [
        "You are not sure which person they mean. Ask",
        "The person themselves is asking. They cannot, and they are blocked anyway",
      ],
    },
    examples: {
      should: ["unblock 919812345678", "let them back in"],
      shouldNot: ["why am I blocked?", "block them again"],
    },
    handler: async (args: { user_id: string; channel?: string | undefined }, ctx: ToolContext) => {
      const found = await find(args, ctx)
      if ("error" in found) return { ok: false, error: found.error }
      const { person } = found

      if (!person.blocked) {
        return { ok: true, changed: false, blocked: false, note: "They were not blocked." }
      }

      await store.people.update({ id: person.id }, { blocked: false })
      return { ok: true, changed: true, blocked: false, who: person.channel_user_id }
    },
  })

  const flag = defineBuiltinTool({
    name: "flag",
    description: "Flags a person's conversation for review, with a reason.",
    input: z.object({
      ...WHO,
      why: z.string().min(1).describe("What should be looked at, in one line"),
    }),
    risk: "read",
    roles: ["operator"],
    conditions: {
      callWhen: [
        "An operator has asked for a conversation to be looked at later, and has said which person and why",
      ],
      dontCallWhen: [
        "They want something done now rather than reviewed later",
        "They have not said what is wrong. Ask, because a flag with no reason is no use to whoever reads it",
      ],
    },
    examples: {
      should: ["flag 919812345678, they keep asking for the manager"],
      shouldNot: ["block them", "what did they say earlier?"],
    },
    handler: async (
      args: { user_id: string; channel?: string | undefined; why: string },
      ctx: ToolContext,
    ) => {
      const found = await find(args, ctx)
      if ("error" in found) return { ok: false, error: found.error }
      const { person } = found

      // LEARN-1: the flag belongs to the flagged person's record, not to
      // the operator's turn, so it is written about them and says who
      // asked for it.
      await events
        .about({ personId: person.id })
        .flag("operator", { why: args.why, by: ctx.person.channelUserId })

      return { ok: true, flagged: person.channel_user_id, why: args.why }
    },
  })

  return [block, unblock, flag]
}
