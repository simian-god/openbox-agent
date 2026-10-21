import { defineTool } from "../../../../src/index.ts"
import { z } from "zod"

export default defineTool({
  name: "opening_hours",
  description: "Says when the restaurant is open on a given day.",
  input: z.object({
    day: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]),
  }),
  risk: "read",
  roles: ["end_user"],
  conditions: {
    callWhen: [
      "The person asks when the restaurant opens or closes",
      "The person asks whether it is open on a particular day",
    ],
    dontCallWhen: [
      "The person is asking whether a table is free at a time",
      "The person is asking how to get here",
    ],
  },
  examples: {
    should: [
      "what time do you open on monday?",
      "are you open on sundays?",
      "how late do you serve on friday?",
    ],
    shouldNot: ["do you have a table at 8 on monday?", "what is on the menu?"],
  },
  handler: async (args) => ({ day: args.day, ranges: [] }),
})
