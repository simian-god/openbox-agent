# Best practices

Read this before writing any part of an agent (SKILL-2). It is the two
vendors' own guidance, condensed, plus what openbox-agent already does for
you so you do not write it into a prompt.

Sources, all read on 2026-10-30:

- Anthropic, effective context engineering for AI agents:
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, writing effective tools for agents:
  https://www.anthropic.com/engineering/writing-tools-for-agents
- OpenAI, prompting guidance for GPT-5.6 Sol:
  https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6

Re-read them when a new model family ships. If what you find disagrees with
this file, the sources win and this file is wrong.

## The one rule

Find the smallest set of high signal tokens that gets the outcome you want.
Every token in a prompt, a tool description or a tool result is spent out of
a budget that is shared with the conversation, and recall drops as that
budget fills. Short is not the goal. Nothing that does not change behaviour
is the goal.

OpenAI's version of the same rule is outcome first: say what the finished
result looks like, what must be true before the agent stops, and what it may
not do. Leave the route to the model. In their own coding evals, cutting
prompts down raised scores while removing most of the tokens.

## Writing the prompt

- **Right altitude.** Too low is a list of if-then rules that break on the
  first case nobody thought of. Too high is "be helpful" and assumes the
  model knows your business. Aim between them.
- **Start minimal, then fix what fails.** Write the shortest prompt that
  could work, run real conversations, and add a line only where you watched
  it go wrong. A line added for a failure you have not seen is a line you
  cannot remove later.
- **Contradictions cost more than gaps.** The model follows a prompt
  closely, so two rules that disagree make it unstable in a way a missing
  rule does not. Read every section against every other one.
- **ALWAYS and NEVER are for true invariants only.** Safety rules, required
  fields, things that must never happen. For a judgement call, give the
  criteria instead: "ask when the party size is over 8" rather than "always
  ask".
- **Say when the turn is done.** Success criteria and stop conditions are
  the two things most often missing. Without them an agent either stops
  halfway or keeps going.
- **Do not repeat an instruction for emphasis.** Saying "ask first" three
  times makes the agent ask permission for safe, expected things.
- **Keep personality short and concrete.** Name the tone and the
  collaboration style in a sentence or two. "Warm but brief, no emoji" beats
  a paragraph about being friendly.
- **A few canonical examples, not a pile of edge cases.** Diverse examples
  that show the shape of a good answer. A long list of rare rules belongs in
  tool conditions or in code.
- **Sections, in a fixed order.** Use the ten headings in
  `prompt-template.md`. Markdown headings are enough.

## Writing tools

- **Build for the agent, not for your API.** A tool is not an endpoint.
  Prefer `search_contacts` over `list_contacts`, and one `schedule_event`
  over a list call plus a create call.
- **Each tool has a clear, distinct purpose.** If a careful person could not
  tell which of two tools to call, the agent cannot either. That is also
  what `dontCallWhen` is for when two tools are genuinely close.
- **Write the description as if briefing a new hire.** Make the implicit
  explicit: what the tool does, when to use it, what it returns, how it
  fails, and any format or terminology that is obvious only inside your
  company.
- **Name parameters unambiguously.** `user_id`, not `user`. Give every field
  a description and a strict type. The core validates arguments against the
  schema before the tool runs, so a strict schema is free safety.
- **Return high signal, and little of it.** Names rather than ids, the five
  fields that matter rather than the row. Paginate or truncate large
  results, and when you truncate, say how to ask for less.
- **Errors should tell the agent how to recover.** "Invalid date format, use
  YYYY-MM-DD, for example 2026-03-01" rather than "invalid input". Errors
  come straight back to the brain, which gets one more chance to get it
  right.
- **Keep the set small.** Routing narrows a long list before the brain sees
  it, which helps, and a tool nobody can tell apart from another is still a
  bad tool after routing.
- **Five `should` and five `shouldNot` examples each** (TOOL-2). Write them
  as real messages, and make sure they agree with the conditions: an example
  the conditions would refuse is a bug in one of the two.

## What the core already does, so leave it out of the prompt

This is the part the vendor guides cannot tell you. Writing any of these
into a prompt is how an agent ends up with two answers to one question.

- **Dates and times.** `ctx.time` resolves phrases, checks opening hours and
  formats in the agent's timezone. A prompt that does date arithmetic will
  get it wrong, and it already has: see the M1 note in `docs/Progress.md`.
- **Whether a risky call may run.** The gate asks one yes or no question
  about every `write` and `irreversible` call, against the tool's own
  conditions. Write the conditions, not a prompt rule.
- **Confirmation of anything irreversible.** The core creates the pending
  action, sends the signed buttons or the four digit code, and refuses a
  confirm from anyone else, after expiry, or with the details changed. The
  prompt only has to not claim the thing is done.
- **Handover.** Every trigger in HAND-1 is the core's, including repeated
  blocks, repeated tool failures and a person asking for a human. The prompt
  says when to call `escalate`, nothing more.
- **Rate limits, the step cap and the spend cap.** Fixed replies, already
  written.
- **Remembering people and open tasks.** Facts, tasks and what is still
  missing are in the runtime block every turn.
- **Knowledge.** `search_knowledge` reads the agent's own files. Do not
  paste a menu or a price list into the prompt.

## Checking it

- Run the checklist in `checklist.md` over everything you wrote, and show
  the builder the result.
- Measure rather than argue. `openbox tune` reports the routing threshold
  from labeled examples, and `bun run c8` says whether routing is paying for
  itself.
- Fix a regression by finding the one instruction or contradiction behind
  it, editing that, and running the same conversations again. Do not rewrite
  a working prompt wholesale.
