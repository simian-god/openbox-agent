import { defineTool } from "../../../../src/index.ts"
import { z } from "zod"

export default defineTool({
  name: "parking",
  description: "Says what parking there is and whether it has to be booked.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: {
    callWhen: ["The person asks about parking, valet or where to leave a car"],
    dontCallWhen: [
      "The person is asking for directions rather than parking",
      "The person is asking about a booking",
    ],
  },
  examples: {
    should: ["is there parking?", "can i leave the car somewhere nearby?", "do you do valet?"],
    shouldNot: ["how do i get there from the station?", "what time do you open?"],
  },
  handler: async (_args) => ({ spaces: 14, booking: false }),
})
