import { defineTool } from "../../../../src/index.ts"
import { z } from "zod"

export default defineTool({
  name: "book_table",
  description: "Books a table, which cannot be undone without cancelling it.",
  input: z.object({
    date: z.string(),
    time: z.string(),
    size: z.number().int().min(1),
    name: z.string(),
  }),
  risk: "irreversible",
  roles: ["end_user"],
  conditions: {
    callWhen: [
      "The person has agreed to a specific date, time and party size",
      "A name to hold the booking under is known",
    ],
    dontCallWhen: [
      "The person is still asking whether a time is available",
      "The date, the time or the party size is still unsettled",
    ],
  },
  confirmSummary: (args) => `Table for ${args.size} on ${args.date} at ${args.time}`,
  examples: {
    should: [
      "yes, book friday 8pm for four under asha",
      "that works, please book it for me, name is ravi",
      "go ahead and reserve saturday at 7 for two, under meera",
    ],
    shouldNot: ["do you have anything on friday?", "how many people can you fit?"],
  },
  handler: async (args) => ({ booked: true, reference: `BK-${args.date}` }),
})
