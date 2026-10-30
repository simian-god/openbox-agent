// Starter data, run once after `openbox migrate`:
//
//   bun run db/seed.ts
//
// What a seed is for is the first operator (ROLE-2). An agent with no
// operator has nobody to hand a conversation to, and nobody who can make
// anyone else an operator, so the first one has to come from outside the
// conversation. After this, use the command:
//
//   openbox operator add <channel> <id>
//
// Everything here is written so running it twice changes nothing. A seed
// that inserts blindly fails the second time on a unique index, or worse,
// quietly makes two of something.
import { createStore, supabaseFromEnv } from "openbox-agent"
import config from "../agent.config.ts"

const store = createStore(supabaseFromEnv(), config.name)

// {{first_operator}}: the channel and the id the builder gave. On
// WhatsApp the id is the phone number in full, with the country code and
// no plus. On Telegram it is the numeric user id, not the @name.
const OPERATORS = [{ channel: "whatsapp", channelUserId: "" }]

for (const operator of OPERATORS) {
  if (operator.channelUserId === "") {
    throw new Error(
      "db/seed.ts still has an empty operator id. Fill in the channel and id the builder gave, " +
        "or take the entry out: an agent with no operator has nobody to hand a conversation to.",
    )
  }

  // Found rather than inserted, so a person who has already written keeps
  // their history, their facts and their open tasks (ROLE-2).
  const existing = await store.people.find({
    channel: operator.channel,
    channel_user_id: operator.channelUserId,
  })

  if (existing === null) {
    await store.people.insert({
      channel: operator.channel,
      channel_user_id: operator.channelUserId,
      role: "operator",
    })
    console.log(`operator added: ${operator.channel} ${operator.channelUserId}`)
  } else if (existing.role === "operator") {
    console.log(`already an operator: ${operator.channel} ${operator.channelUserId}`)
  } else {
    await store.people.update({ id: existing.id }, { role: "operator" })
    console.log(`promoted to operator: ${operator.channel} ${operator.channelUserId}`)
  }
}

// {{other_seed_data}}: anything else the agent needs on day one, like a
// price list or the rows behind a tool. Knowledge files are not seeded:
// they live in `knowledge/` and are read at startup (KNOW-1).
