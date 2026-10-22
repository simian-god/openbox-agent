// Section 10: `remember` and `forget_fact`.
//
// Two tools, and most of the care is in what they refuse. A fact is the
// only thing in the system the brain writes and then reads back as truth
// on every later turn, so a bad one does not go away: it sits in the
// runtime block being believed until somebody notices.
//
// So a key is normalised, a value has a length, and `forget_fact` is for
// the person asking rather than for the brain tidying up. The brain is
// told what it stored, because a tool that silently rewrites a key gets
// called twice.
import { z } from "zod"
import { isUniqueViolation, type FactRow, type Store } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"
import { defineBuiltinTool, type Tool, type ToolContext } from "./define.ts"

/** How long a fact's value may be. Long enough for a sentence. */
export const MAX_FACT_VALUE = 500

/** How many facts one person may have. */
export const MAX_FACTS = 50

/**
 * A key, as it is stored.
 *
 * Lower case, spaces and dashes to underscores, nothing else. Without this
 * "Allergies", "allergies" and "allergy " are three facts, and the brain
 * will write all three over a long conversation and then read them back as
 * though they were different things.
 */
export function factKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
}

export interface FactToolOptions {
  store: Store
  clock: Clock
}

/** LOOP-7: everything known about one person, oldest key first. */
export async function factsFor(store: Store, personId: string): Promise<FactRow[]> {
  const rows = await store.facts.list({ person_id: personId }, { orderBy: "key" })
  return rows
}

export function factTools(options: FactToolOptions): Tool[] {
  const { store, clock } = options

  const remember = defineBuiltinTool({
    name: "remember",
    description:
      "Saves or updates one fact about this person, so it is known on every later turn. Use a short stable key.",
    input: z.object({
      key: z.string().min(1).describe("A short stable name, like allergies or usual_order"),
      value: z.string().min(1).describe("What to remember, in a few words"),
    }),
    risk: "read",
    roles: ["end_user"],
    conditions: {
      callWhen: [
        "The person has said something about themselves that will matter next time",
        "Something you already remember about them has changed",
      ],
      dontCallWhen: [
        "It is part of what they are asking for right now. That belongs on the task",
        "They did not say it about themselves, or you inferred it rather than being told",
        "It is something you can look up again, like today's opening hours",
      ],
    },
    examples: {
      should: [
        "i am allergic to peanuts",
        "we always sit by the window",
        "my name is Asha, not Aisha",
      ],
      shouldNot: ["a table for four tonight", "what time do you close?"],
    },
    handler: async (args: { key: string; value: string }, ctx: ToolContext) => {
      const key = factKey(args.key)
      if (key === "") {
        return {
          ok: false,
          error: `"${args.key}" is not a usable key. Use letters, numbers and underscores, like allergies.`,
        }
      }

      const value = args.value.trim()
      if (value.length > MAX_FACT_VALUE) {
        // Refused rather than truncated. A fact cut off halfway reads as a
        // complete fact on every later turn, and nothing downstream can
        // tell that something was lost.
        return {
          ok: false,
          error: `That value is ${value.length} characters and the limit is ${MAX_FACT_VALUE}. Store the short version, or put the detail on the task.`,
        }
      }

      let existing = await store.facts.find({ person_id: ctx.person.id, key })

      if (existing === null) {
        const count = await store.facts.count({ person_id: ctx.person.id })
        if (count >= MAX_FACTS) {
          return {
            ok: false,
            error: `This person already has ${count} facts, which is the limit. Use forget_fact first if one is no longer true.`,
          }
        }

        try {
          const row = await store.facts.insert({
            person_id: ctx.person.id,
            key,
            value,
            updated_at: clock.now().toISOString(),
          })
          return { ok: true, remembered: { key: row.key, value: row.value }, replaced: null }
        } catch (error) {
          // Somebody else remembered the same key between the read above
          // and this insert. The unique constraint is what noticed, and
          // what the person said is still what should be stored, so this
          // becomes the update it would have been a moment later.
          if (!isUniqueViolation(error)) throw error
        }
      }

      const [updated] = await store.facts.update(
        { person_id: ctx.person.id, key },
        { value, updated_at: clock.now().toISOString() },
      )
      return {
        ok: true,
        remembered: { key, value: updated?.value ?? value },
        // Said back, so a brain that is correcting something knows it
        // replaced an answer rather than added one.
        replaced: existing === null || existing.value === value ? null : existing.value,
      }
    },
  })

  const forgetFact = defineBuiltinTool({
    name: "forget_fact",
    description: "Removes a fact about this person, when they ask you to.",
    input: z.object({ key: z.string().min(1) }),
    risk: "read",
    roles: ["end_user"],
    conditions: {
      callWhen: [
        "The person has asked you to forget something about them",
        "They have said something you remember about them is wrong and has no replacement",
      ],
      dontCallWhen: [
        "They gave you a new value instead. Use remember, which replaces it",
        "You simply have no use for it right now. It costs nothing to keep",
      ],
    },
    examples: {
      should: ["forget my usual order", "stop keeping my birthday"],
      shouldNot: ["change my usual to the thali", "what do you know about me?"],
    },
    handler: async (args: { key: string }, ctx: ToolContext) => {
      const key = factKey(args.key)
      const existing = await store.facts.find({ person_id: ctx.person.id, key })

      if (existing === null) {
        const known = await factsFor(store, ctx.person.id)
        return {
          ok: false,
          error:
            known.length === 0
              ? "There is nothing remembered about this person."
              : `There is nothing remembered under "${key}". What is remembered: ${known
                  .map((fact) => fact.key)
                  .join(", ")}.`,
        }
      }

      await store.facts.remove({ id: existing.id, person_id: ctx.person.id })
      return { ok: true, forgot: { key: existing.key, value: existing.value } }
    },
  })

  return [remember, forgetFact]
}
