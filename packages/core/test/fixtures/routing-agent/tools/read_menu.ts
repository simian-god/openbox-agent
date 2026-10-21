import { defineTool } from "../../../../src/index.ts"
import { z } from "zod"

export default defineTool({
  name: "read_menu",
  description: "Looks up dishes on the menu, by name or by dietary need.",
  input: z.object({ query: z.string() }),
  risk: "read",
  roles: ["end_user"],
  conditions: {
    callWhen: [
      "The person asks what food or drink is served",
      "The person asks whether something suits a diet or an allergy",
    ],
    dontCallWhen: [
      "The person is asking about a booking",
      "The person is asking when the restaurant is open",
    ],
  },
  examples: {
    should: [
      "what is on the menu tonight?",
      "do you have anything without dairy?",
      "is the paneer tikka still on?",
    ],
    shouldNot: ["can i book a table for two?", "where exactly are you?"],
  },
  handler: async (args) => ({ matches: [args.query] }),
})
