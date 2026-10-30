// The terminal channel, for talking to the agent on your own machine.
//
// This is a wrapper and not an implementation: the core ships the
// terminal channel that `openbox chat` uses, so a second one here would
// be a second thing to keep in step. What this adds is the `serve` shape
// the other channels have, so `main.ts` can run the agent in a terminal
// by changing one import while a real channel is being set up.
//
// SKILL-6: a terminal session wants `burstWindowMs: 0`, so one typed line
// is one turn. The default of 3000 exists for a channel where somebody
// sends three messages in a row before the first is answered, which is
// not how typing at a prompt works. `openbox chat` sets it for you; set
// it in the config yourself if you run this from `main.ts`.
//
// Confirm buttons are printed numbered, and a person taps one by typing
// its number. Nothing here reads the payload (CONF-7): the core is handed
// the payload of whichever button was chosen.
import { stdio, terminalChannel } from "openbox-agent"
import type { Agent } from "openbox-agent"

const CHANNEL = "terminal"

// {{terminal_user}}: who you are in the conversation. Change it to try
// the agent as a second person, or as an operator once you have run
// `openbox operator add terminal <id>`.
//
// `stdio()` is the core's own keyboard and screen, so this file does not
// read a byte stream of its own.
const channel = terminalChannel({ io: stdio(), channelUserId: "local" })

export default {
  sender: channel.sender,
  async serve(agent: Agent): Promise<void> {
    if (agent.config.burstWindowMs !== 0) {
      console.log(
        `note: ${CHANNEL} reads best with burstWindowMs: 0, and this agent has ` +
          `${agent.config.burstWindowMs}. A typed line will wait that long before it is answered.`,
      )
    }
    await channel.run(agent)
  },
}
