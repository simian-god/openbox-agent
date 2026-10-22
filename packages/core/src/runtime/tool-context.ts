// TOOL-4: what a tool handler is given.
//
// In its own file because two places build one now. A step builds it to
// run a tool, and a confirmation builds it to run the tool the person just
// agreed to (CONF-4). Those have to be the same context, or a tool would
// behave differently depending on whether it was confirmed, which is the
// one difference nobody would think to test for.
import type { PersonRow, Store } from "../store/index.ts"
import type { Clock } from "../testing/clock.ts"
import type { ToolContext } from "../tools/index.ts"

export function toolContext(input: { store: Store; clock: Clock; person: PersonRow }): ToolContext {
  const { store, clock, person } = input
  return {
    clock,
    person: {
      id: person.id,
      role: person.role,
      channel: person.channel,
      channelUserId: person.channel_user_id,
      displayName: person.display_name,
      language: person.language,
    },
    db: store,
    // `ctx.log` goes to the turn's record. Nothing reads it yet, so it is
    // deliberately a no op rather than a console write a builder would
    // then find in production logs.
    log: () => {},
  }
}
