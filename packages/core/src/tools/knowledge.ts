// Section 10: `search_knowledge`, `approve_knowledge` and `reject_knowledge`.
//
// Three tools and one rule between them. LEARN-6 says a candidate from a
// handover is not searchable until an operator has approved it, and KNOW-2
// says approving one takes effect at once with no restart. So approval is
// the only thing in this core that changes what the agent knows while it
// is running, which LEARN-7 calls out as the single exception to nothing
// changing the agent without the builder.
//
// That is why approving indexes immediately rather than marking the row
// and leaving the index to catch up on the next deploy: the operator
// answered a question a minute ago, and the next person to ask it should
// get the answer rather than another handover.
//
// `search_knowledge` hands the brain the text and where it came from, and
// not the score. A score here is normalised against the best match for
// that one query (KNOW-4), so it means nothing on its own, and a brain
// given a number will reason about it.
import { z } from "zod"
import type { OpenboxConfig } from "../config/index.ts"
import { entryDoc } from "../knowledge/index.ts"
import type { Retriever } from "../providers/retrievers/types.ts"
import type { Clock } from "../testing/clock.ts"
import type { Store } from "../store/index.ts"
import type { EventWriter } from "../runtime/events.ts"
import { defineBuiltinTool, type Tool } from "./define.ts"

export interface KnowledgeToolOptions {
  config: OpenboxConfig
  store: Store
  clock: Clock
  /** KNOW-3: what a search searches. */
  retriever: Retriever
  /** EVT-2: where `knowledge_searched` is recorded. */
  events: EventWriter
  /**
   * KNOW-1 and KNOW-2: makes sure the index is built before a search, and
   * adds one document to it after an approval.
   *
   * Injected because the agent owns when indexing happens: it starts at
   * `start()` and a search waits for the same promise, so a question
   * asked in the first second does not race a half built index.
   */
  indexed: () => Promise<void>
}

export function knowledgeTools(options: KnowledgeToolOptions): Tool[] {
  const { config, store, clock, retriever, events, indexed } = options

  const search = defineBuiltinTool({
    name: "search_knowledge",
    description:
      "Searches the agent's own documents and the answers operators have approved. Use it before saying you do not know something.",
    input: z.object({
      query: z
        .string()
        .min(1)
        .describe("What to look for, in the words the person used if you can"),
    }),
    risk: "read",
    roles: ["end_user", "operator"],
    conditions: {
      callWhen: [
        "The person asks something the conversation does not already answer",
        "You are about to say you do not know, or to hand over for an answer",
      ],
      dontCallWhen: [
        "The answer is already in this conversation",
        "They are asking you to do something rather than to tell them something",
      ],
    },
    examples: {
      should: ["do you have parking?", "what is your refund policy?"],
      shouldNot: ["book me a table for four", "hello"],
    },
    handler: async (args, ctx) => {
      await indexed()
      const found = await retriever.search(args.query, config.knowledgeResults)

      await events.about({ personId: ctx.person.id }).record("knowledge_searched", {
        query: args.query,
        results: found.length,
        retriever: retriever.id,
      })

      // Text and source, never the score. See the note at the top.
      return {
        results: found.map((hit) => ({ text: hit.text, source: hit.source })),
        ...(found.length === 0
          ? { note: "Nothing in the documents matches. Say so, or hand over." }
          : {}),
      }
    },
  })

  /** The candidate a decision is about, named the way an operator would. */
  const CANDIDATE = {
    entry_id: z
      .string()
      .min(1)
      .describe("The id of the candidate, as it was shown to you in the review"),
  }

  const approve = defineBuiltinTool({
    name: "approve_knowledge",
    description:
      "Approves a knowledge candidate, so the agent can use that answer from now on. Takes effect at once.",
    input: z.object(CANDIDATE),
    risk: "read",
    roles: ["operator"],
    conditions: {
      callWhen: ["An operator has told you to approve a particular candidate, naming which"],
      dontCallWhen: [
        "They are discussing a candidate without deciding on it",
        "They have not said which candidate they mean",
      ],
    },
    examples: {
      should: ["approve knowledge 3f2a", "yes, that answer is right, approve it"],
      shouldNot: ["what candidates are waiting?", "that answer looks wrong"],
    },
    handler: async (args, ctx) => decide(args.entry_id, "approved", ctx.person.id),
  })

  const reject = defineBuiltinTool({
    name: "reject_knowledge",
    description:
      "Rejects a knowledge candidate, so the agent never uses that answer. The record of it stays.",
    input: z.object(CANDIDATE),
    risk: "read",
    roles: ["operator"],
    conditions: {
      callWhen: ["An operator has told you to reject a particular candidate, naming which"],
      dontCallWhen: [
        "They are discussing a candidate without deciding on it",
        "They have not said which candidate they mean",
      ],
    },
    examples: {
      should: ["reject knowledge 3f2a", "no, that answer is wrong"],
      shouldNot: ["what candidates are waiting?", "approve that one"],
    },
    handler: async (args, ctx) => decide(args.entry_id, "rejected", ctx.person.id),
  })

  /**
   * One path for both decisions, because the difference is one word and
   * whether the answer joins the index.
   *
   * DATA-4's conditional claim, on `status: "candidate"`: two operators
   * deciding at once, or the same operator's message arriving twice, must
   * not index the answer twice or overwrite the first decision. The one
   * whose update returns a row decided it; the other is told what
   * happened rather than told it failed.
   */
  async function decide(
    entryId: string,
    status: "approved" | "rejected",
    operatorId: string,
  ): Promise<Record<string, unknown>> {
    const entry = await store.knowledge.byId(entryId)
    if (entry === null) return { ok: false, why: `there is no knowledge candidate ${entryId}` }

    const [claimed] = await store.knowledge.update(
      { id: entryId, status: "candidate" },
      { status, decided_at: clock.now().toISOString(), decided_by: operatorId },
    )

    if (claimed === undefined) {
      // Already decided, by somebody else or by this message arriving
      // twice. Idempotent on purpose: an operator who repeats themselves
      // is told the outcome, not told off.
      const now = await store.knowledge.byId(entryId)
      return {
        ok: now?.status === status,
        status: now?.status ?? "unknown",
        why: "this candidate had already been decided",
      }
    }

    // KNOW-2: searchable from now, with no restart. After the claim, so
    // the index is only told about an answer that is really approved.
    if (status === "approved") {
      await indexed()
      await retriever.index([entryDoc(claimed)])
    }

    return { ok: true, status, question: claimed.question }
  }

  return [search, approve, reject]
}
