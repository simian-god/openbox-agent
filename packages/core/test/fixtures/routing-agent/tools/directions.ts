import { defineTool } from "../../../../src/index.ts"
import { z } from "zod"

export default defineTool({
  name: "directions",
  description: "Gives the address and how to reach the restaurant.",
  input: z.object({ from: z.string().optional() }),
  risk: "read",
  roles: ["end_user"],
  conditions: {
    callWhen: [
      "The person asks where the restaurant is",
      "The person asks how to get here from somewhere",
    ],
    dontCallWhen: [
      "The person is asking about parking specifically",
      "The person is asking about a booking or the menu",
    ],
  },
  examples: {
    should: [
      "where are you exactly?",
      "how do i get there from the station?",
      "what is the address?",
    ],
    shouldNot: ["is there parking outside?", "can i book for tonight?"],
  },
  handler: async (_args) => ({ address: "12 Market Road" }),
})
