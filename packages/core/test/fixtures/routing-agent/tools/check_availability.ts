import { defineTool } from "../../../../src/index.ts"
import { z } from "zod"

export default defineTool({
  name: "check_availability",
  description: "Checks whether a table is free at a date, time and party size.",
  input: z.object({ date: z.string(), time: z.string(), size: z.number().int().min(1) }),
  risk: "read",
  roles: ["end_user"],
  conditions: {
    callWhen: [
      "The person asks whether a table is free, or whether a time is possible",
      "The person has given enough of a date, a time and a party size to look one up",
    ],
    dontCallWhen: [
      "The person has already agreed to a booking and is waiting for it to be made",
      "The person is asking about the menu, the hours or how to get here",
    ],
  },
  examples: {
    should: [
      "do you have a table for four on friday at 8?",
      "any space tomorrow evening for two?",
      "is 7pm possible for six people on saturday?",
    ],
    shouldNot: ["yes please, book that one", "what time do you close on sunday?"],
  },
  handler: async (args) => ({ free: args.size <= 6 }),
})
