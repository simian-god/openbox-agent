import { defineTool } from "../../../../src/index.ts"
import { z } from "zod"

export default defineTool({
  name: "cancel_booking",
  description: "Cancels a booking the person already has.",
  input: z.object({ reference: z.string() }),
  risk: "write",
  roles: ["end_user"],
  conditions: {
    callWhen: [
      "The person says they want to cancel a booking they have",
      "A booking reference is known, or there is only one booking to cancel",
    ],
    dontCallWhen: [
      "The person wants to move the booking rather than drop it",
      "The person has no booking yet",
    ],
  },
  examples: {
    should: [
      "i need to cancel my booking tonight",
      "please cancel BK-2026-10-23, something came up",
      "we are not coming any more, cancel it",
    ],
    shouldNot: ["can i move it to 9 instead?", "i have not booked anything yet"],
  },
  handler: async (args) => ({ cancelled: args.reference }),
})
