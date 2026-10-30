// One tool. Copy this per tool, rename the file to the tool's own name,
// and fill every hole.
//
// The conditions are the most important part of the file. They are what
// the gate reads before a `write` or `irreversible` call runs (GATE-1), so
// a rule about when this tool is right belongs here and not in the prompt.
// A prompt copy of the same rule is checklist item 9.
import { defineTool } from "openbox-agent"
import { z } from "zod"

export default defineTool({
  // {{tool_name}}: snake_case, a verb and its object, like
  // `check_availability` or `cancel_booking`.
  name: "do_the_thing",

  // {{tool_description}}: one line, written for the brain. What it does,
  // not how. The brain also sees the conditions below, so do not repeat
  // them here.
  description: "Does the thing, and returns what happened.",

  // {{tool_input}}: every argument, each with a `.describe()` the brain
  // reads. Keep the types tight: a closed list the tool can act on beats
  // free text it has to interpret, and a date the brain worked out itself
  // is the one argument never to accept. Pass the weekday and resolve it
  // here with `ctx.time`.
  input: z.object({
    size: z.number().int().positive().describe("how many people, as a whole number"),
    day: z
      .enum(["today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday"])
      .describe("which day the person means. Never work out a date yourself"),
  }),

  // {{tool_risk}}: `read` is never gated and is the default to reach for.
  // `write` changes something that can be put back. `irreversible` cannot
  // be undone, and is never run without the person's own confirmation.
  risk: "read",

  // {{tool_roles}}: who may use it. An end user never sees an operator
  // only tool, whatever they claim about themselves (ROLE-3).
  roles: ["end_user", "operator"],

  // {{tool_conditions}}: when this tool is right, and when it is wrong.
  // Each line is a sentence about the conversation that is true or false.
  // `dontCallWhen` is also what separates two tools whose `callWhen`
  // lines could both be true of one message (checklist item 5).
  conditions: {
    callWhen: [
      "The person asks for the thing this tool does",
      "The person has given every detail the input needs",
    ],
    dontCallWhen: [
      "A detail the input needs is still missing, so ask for it instead",
      "This exact call was already made in this conversation and nothing changed",
    ],
  },

  // {{tool_examples}}: at least five real messages each way. They are the
  // labeled set `openbox tune` measures routing against (LEARN-5), so
  // write what people actually type, misspellings included. Every
  // `should` has to be a message the conditions above would allow.
  examples: {
    should: [
      "can you do the thing for four people tomorrow?",
      "thing for 2 on friday please",
      "need the thing today, 6 of us",
      "do the thing for me monday, party of 3",
      "can i get the thing on wednesday for five",
    ],
    shouldNot: [
      "what are your opening hours?",
      "where are you?",
      "how much does it cost?",
      "thanks, see you then",
      "can i speak to someone?",
    ],
  },

  // {{tool_confirm_summary}}: required for an `irreversible` tool, and
  // left out for anything else (CFG-1 refuses the first case). It is what
  // the person reads before they tap Confirm, so it names the action and
  // every detail that would make somebody say no: the date, the time, the
  // amount, the name. Never the tool's name.
  //
  // confirmSummary: (args) => `Cancel your booking for ${args.size} on ${args.day}?`,

  handler: async (args, ctx) => {
    // {{tool_handler}}: the real work. Four rules worth keeping.
    //
    // Dates come from `ctx.time`, never from the brain and never from
    // `new Date()`: the agent's own timezone is the one that counts
    // (TIME-1).
    const when = ctx.time.resolve(args.day)

    // An ambiguous phrase is an answer, not a failure. Hand it back and
    // let the brain ask which one was meant (TIME-3). A tool that picked
    // one would be guessing with somebody's booking.
    if (when.kind === "ambiguous") {
      return { ok: false, why: when.why, candidates: when.candidates.map((one) => one.text) }
    }

    // Refuse what the business would refuse, here rather than in the
    // prompt. A tool that cannot be talked round is the only kind that
    // cannot be talked round.
    if (!ctx.time.isOpen(when.at)) {
      const next = ctx.time.nextOpen(when.at)
      return { ok: false, why: "closed then", nextOpen: next ? ctx.time.format(next) : null }
    }

    // Return what the brain needs to answer and nothing else. An error
    // says how to get it right, because the brain reads it and gets one
    // more go.
    return { ok: true, size: args.size, when: ctx.time.format(when.at) }
  },
})
