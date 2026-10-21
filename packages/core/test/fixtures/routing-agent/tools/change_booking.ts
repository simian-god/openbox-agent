import { defineTool } from "../../../../src/index.ts"
import { z } from "zod"

export default defineTool({
  name: "change_booking",
  description: "Changes the time or the party size of a booking.",
  input: z.object({
    reference: z.string(),
    time: z.string().optional(),
    size: z.number().int().min(1).optional(),
  }),
  risk: "write",
  roles: ["end_user"],
  conditions: {
    callWhen: [
      "The person wants to keep their booking but change a detail of it",
      "The booking they mean is clear",
    ],
    dontCallWhen: [
      "The person wants to cancel outright",
      "The person is asking whether a different time is even free",
    ],
  },
  examples: {
    should: [
      "can you make my booking six people instead of four?",
      "move BK-2026-10-23 to 9pm please",
      "same night, but we will be two more",
    ],
    shouldNot: ["cancel it please", "is 9pm free on friday?"],
  },
  handler: async (args) => ({ changed: args.reference }),
})
