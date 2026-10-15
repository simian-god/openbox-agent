# Intent: openbox-agent

The core package is `openbox-agent`. The skill that builds agents on it is invoked as `/openboxagent`.

## Problem

An agent builder who ships agents across domains, say a restaurant agent and then a dentist agent, needs the same plumbing every time: a brain they can swap per agent, a way to pick and run the right tool, and memory of the conversation and the person. Today that plumbing gets rebuilt for each new agent, burning the same tokens and time again and again on code that doesn't change, instead of on what's actually different per agent: its tools, its rules, its knowledge and its voice.

At runtime, a large model picking from the full tool list is slow, costs more, and can pick a wrong or nonexistent tool. A small decision model built for that one job is faster and can only answer with tools that exist. Even the right tool can be called at the wrong moment, like placing an order before the person has confirmed it.

The system prompt is the other cost that repeats. A thin brief gives a thin prompt, and builders rarely write down everything the agent needs to know unless someone makes them.

Real conversations are messy, and every agent hits the same mess. People ask for a human. Webhooks deliver the same message twice. People send three messages at once, or a voice note. A booking takes several turns, dates get misread, and someone has to send the reminder. Each agent ends up solving these again, usually badly.

And agents don't get better after launch unless someone closes the loop between what went wrong in real conversations and what changes in the agent.

These agents talk to two kinds of people, the end users and the operators behind the agent, so the plumbing also has to know who's on the other end.

## Goals

### Plumbing

1. Write the plumbing once. A new agent is just its tools, rules, knowledge and voice.
2. Swap the brain per agent through config: OpenRouter, Claude Agent SDK, OpenAI Agents SDK, Claude Code or Codex, with a fallback list for when one fails. Claude Code and Codex are for building and local testing only; live agents run on API brains.
3. Swap the decision model per agent through config too: Jev and OpenAI Decisions API at launch, Laya later.
4. Context lives in a SQL database the builder owns: conversation history, facts about each person, tasks in progress, pending actions, scheduled messages and review flags. The core ships its own tables as migrations, and each agent adds its own tables on top. Every core row carries an agent ID, so one database can hold several agents later.
5. The agent knows whether it's talking to an end user or an operator, and each tool says which of them may use it.
6. Every message carries a channel value (Discord, WhatsApp, Telegram, a custom web or mobile app, anything). The core stores it and hands it to the brain and tools so replies can fit the channel. Operators have a channel too.

### Tools and safety

7. Every tool carries conditions (when to call it and when not to) and a risk level: read, write or irreversible. The core won't register a tool without both conditions. The same conditions feed the decision model and the tool description the brain sees, so there's one source of truth.
8. The decision model uses those conditions twice. First it scores every tool to pick the one to use, faster and cheaper than the brain and never one that doesn't exist. Then, for tools that write or can't be undone, it scores the brain's proposed call against that tool's conditions before it runs, and a low score blocks the call or sends it back for confirmation. Read tools skip this check, since reading at the wrong moment does no harm. Accuracy is measured on real tool sets, not assumed.
9. Irreversible tools never run on the brain's say so. They create a pending action with a plain summary, and it runs only when that same person taps Confirm, or replies with a short code on a channel without buttons. Pending actions expire, and they're cancelled if the details change. This confirm logic lives in the core, written and tested once.
10. Limits on abuse and spend: messages per person per window, steps per turn, and a daily spend cap per agent. Hitting a limit sends a polite fixed message and alerts an operator. Hitting the spend cap switches the agent to handover only. Operators can block a person.

### Real conversations

11. Handing over to a human. The brain can call a built in escalate tool whenever it judges a human is needed, and fixed triggers fire regardless of the model: the person asks for a human, the gate blocks or a pick comes back low confidence twice in a row, or a tool fails twice. On handover the bot goes quiet for that person and an operator is alerted with a short summary. The operator's replies reach the person through the agent. Control returns when the operator ends it or after an idle timeout. If no operator answers in time, the person is told someone will get back to them, and the case stays open.
12. Operators work through their own channel, with no dashboard. They get alerts and send replies there, and their commands (take over, resume, block, approve knowledge) are operator only tools that go through the same roles and events as everything else. For browsing conversations, they use the Supabase table editor.
13. Messy delivery is handled. Each incoming message is processed exactly once, using the channel's message ID. Messages from one person are handled in order, one turn at a time. Quick bursts, and messages that arrive while a turn is running, merge into the next turn. All of this holds with two server processes on one database. Failed sends are retried, and a send that went through is never repeated. When a send times out and the channel can't say whether it went through, the core doesn't resend unless the channel handles duplicate sends safely, and it flags the message instead.
14. Multi turn tasks keep their own record: type, fields collected so far, what's missing, status and expiry. The brain sees open tasks every turn and updates them through a built in tool. A person can have several open tasks but only one active. A pending action is a task's final stage.
15. Every turn knows the current date, time and weekday in the agent's timezone. The model extracts phrases like "tomorrow 8pm", code resolves them to exact times, and opening hours and availability are checked in tool code. Date math never happens in the model.
16. The agent can start conversations: scheduled messages like reminders, stored in the database so a restart doesn't lose them, and messages triggered by outside events like "order ready". The core follows each channel's rules (on WhatsApp, only approved templates outside the 24 hour window), keeps quiet hours unless a message is urgent, and honors an opt out until the person opts back in.
17. Voice notes go through a swappable transcriber, such as Sarvam's Saaras for Indian languages and Hinglish, or OpenAI. Images go to brains that can read them; otherwise the agent says it can't and offers another way. The agent replies in the language the person writes in unless the prompt says otherwise. Tools can send files, like a menu PDF, through the sender.
18. Knowledge lives in three places: small facts in the prompt, structured data in agent tables behind tools, and longer documents as files searched by a built in `search_knowledge` tool. Search sits behind a swappable retriever: in process by default (keyword search plus embeddings held in memory), with pgvector for large knowledge bases.
19. No message is lost when something outside fails. The brain falls back down its list. If the decision model is down, routing falls back to the brain picking from all tools and the gate fails closed: write calls need the person's confirmation, and irreversible calls still need a structured confirm. Tool errors go back to the brain as results, and repeats trigger a handover. Failed sends are retried. If everything fails, the person gets a fixed "we'll get back to you" message and an operator is alerted.

### Learning

20. Agents improve from real traffic through a loop that never applies itself. The model never changes; everything around it does.
    - The core flags conversations for review: handovers, gate blocks, low confidence picks, tool errors, a frustration score from the decision model, and anything an operator flags. Every turn records the prompt and tool versions, cost and latency.
    - A weekly digest goes to the builder's channel: flag counts by type, cost, and the worst conversations.
    - The skill's review groups flagged conversations by cause and proposes fixes: prompt edits, conditions, example messages, thresholds, knowledge or a new tool. Each failure becomes an evals-agent case. A fix ships only when that case passes, the old suite doesn't regress, and the builder approves.
    - Every reviewed routing decision becomes a labeled example, and thresholds are retuned from the growing set.
    - Operator answers given during handovers become candidate knowledge, which goes live after an operator approves it.

### Personal data

21. A notice is shown on first contact, and the core records that it was shown. Each agent sets a retention period for conversations and facts. One person's data can be erased or exported on request, keeping only the minimal log the law requires. Designed with India's DPDP Rules in mind (the obligations that matter here apply from 13 May 2027), to be confirmed with a lawyer.

### Building agents

22. The repo ships a skill for coding agents (Claude Code, Codex), invoked as `/openboxagent`, that builds agents on the core, so the builder only plugs in creds. It reads a bundled best practices guide before writing anything.
    - **Setup.** Grills the builder with Matt Pocock's grilling skill, because being made to answer draws out the context a good prompt needs. Then it writes the system prompt; every tool with its conditions, handler, roles, risk level, confirm summary and example messages (asking for the API docs of any outside system a tool touches); the agent's own tables and seed data; knowledge files; the glue for the end user and operator channels, including confirm buttons; and the config.
    - **Later changes.** Adds a tool with the same grilling and checks, swaps the brain, decision model, transcriber or retriever, and lets the builder chat with the agent locally.
    - **Review.** Runs the learning loop in goal 20.

### Ecosystem

23. Works as a library other projects build on, starting with a future multi agent project.
24. Any agent built on it can be tested by [evals-agent](https://github.com/simian-god/evals-agent) with no edits to the agent. Providers come in as injected dependencies (brain, decision model, transcriber, retriever, database, sender, clock and event sink), and every brain call, tool pick, gate decision, confirmation, handover, tool run, database write and outbound message passes through one of them, whichever brain is plugged in.
25. Open source, released alongside evals-agent as a suite of reusable code.

## Non goals

- Building any specific agent. Restaurant and dentist agents come later, on top of this.
- Connecting to channels inside the core. The core takes the channel as a value and never talks to Discord, WhatsApp or anything else directly. The skill writes that glue into each agent's project instead.
- A UI or dashboard. Operators use their channel and the Supabase table editor. A custom operator UI connects as just another channel.
- Multi agent orchestration. That's a separate project that uses this one, so single and multi agent logic never mix.
- Evaluating agents. evals-agent does that from outside; the core only has to be testable.
- Hosting. Where the agent runs is the builder's call.
- Fine tuning models.
- Agents that change themselves. Every change is approved by the builder.
- Several agents in one process. v1 runs one agent per process and database; the agent ID on every row makes sharing possible later.

## Constraints

- TypeScript, running on Bun. The evals harness loads the agent in process on Bun, and any other language would need a transport and extra instrumentation added to evals-agent.
- CLI brains run only in development mode. A production config that lists one fails to start.
- Tools always run inside the core, even when the brain is an SDK or CLI with its own loop, so every tool run stays visible, gated and testable.
- Safety critical logic (gating, confirmation, delivery guarantees, handover) lives in the core and is never generated per agent.
- Confidence thresholds are set per decision model. Confidence means different things across vendors, so a threshold tuned on one never carries over to another.
- The gate is one layer of safety, not the only one. Decision models can be steered by text in the conversation, so irreversible tools rely on structured confirmation, and every tool checks its own inputs in code.
- Time and date math happen in code, with the clock injected so tests can freeze it.
- The skill depends on Matt Pocock's grilling skill (MIT), installed separately rather than copied in, since it's still changing.
- The schema is plain Postgres DDL (schema plus migrations) with a seed function. Core behavior doesn't depend on RLS, triggers or pgvector, because the eval world is SQLite translated from that DDL and doesn't enforce them. RLS is still switched on for every table, core and agent, so only the agent's service key can reach them, never a public anon key. Migrations fail if any table has it off. pgvector is used only by the optional retriever, and agents that use it need vector search added to evals-agent's world, likely via sqlite-vec.
- Database access goes through supabase-js first, since that's the client evals-agent captures today. Other clients can come later behind the same store interface.
- No secrets in the repo. Every key comes from the environment.
- MIT license, same as evals-agent.

## Success criteria

Numbers match the goals.

1. The second agent built on the core ships with zero changes to core code. The first one is allowed to expose gaps.
2. One agent runs the same scripted conversation on all five brains, switching by config only, and passes the same tests on each. Killing the primary brain mid conversation moves to the fallback with no lost message.
3. The same agent runs on Jev and on OpenAI Decisions API by changing config only.
4. Every core table carries an agent ID. Core migrations apply cleanly to an empty Postgres and translate into evals-agent's world. Kill the process mid conversation, or swap the brain, and the next message picks up with full history, facts and open tasks. Everything stored is readable with plain SQL.
5. An end user can't trigger an operator only tool, and typing "I'm the owner" changes nothing, checked by evals-agent cases.
6. The same agent serves two channels with no code change, and every stored message records its channel.
7. Registering a tool without both conditions fails with a clear error.
8. On a labeled set of messages per agent, for each decision model:
   - No call to a tool that doesn't exist, ever.
   - Turns routed by the decision model have lower median latency and cost than the same turns without it.
   - With low confidence picks falling back to the brain, tool accuracy is at least as good as the brain alone.
9. In evals-agent cases, an irreversible tool never runs without a valid confirm from the same person: not on "why do you keep asking, i already told you", not on a confirm from someone else, not after expiry, and not after the details changed.
10. A flood of messages hits the rate limit and gets the fixed reply. No turn exceeds the step cap. Crossing the spend cap switches the agent to handover only.
11. Every trigger (asking for a human, the escalate tool, repeated blocks or low confidence, repeated tool failures, operator take over) hands over. The bot sends nothing to that person while handed over. Control returns on resume or idle timeout, and the no operator timeout sends the holding message.
12. An operator can take over, reply, resume, block and approve knowledge entirely from their channel.
13. The same webhook delivered twice is processed once. Three messages inside the burst window produce one turn. Two server processes on one database never process the same person in parallel. A send that times out is never delivered twice: it's resent only on channels that handle duplicates safely, and flagged otherwise.
14. A booking spread over five turns, with an unrelated question in the middle, completes with every field correct. An idle task expires.
15. With a frozen clock, "tomorrow 8pm" resolves correctly across midnight, month end and the agent's timezone. A request outside opening hours is refused by tool code even when the brain tries.
16. A scheduled reminder survives a restart and sends exactly once. On WhatsApp outside the window, only a template goes out. Nothing non urgent goes out in quiet hours. After STOP, nothing goes out until the person opts back in.
17. A voice note in Hindi or Hinglish is transcribed and answered in the same language. An image sent to a text only brain gets the fallback reply. A tool can send a PDF.
18. Questions answerable only from a knowledge file get correct answers with both retrievers.
19. With each dependency failed in turn (brain, decision model, a tool, the sender, then all at once), no message is lost, and the person always gets an answer or the holding message. A decision model outage never lets an irreversible tool run.
20. Learning loop:
    - Every flag type is raised by a case built to trigger it, and the weekly digest arrives with correct counts.
    - The review turns a flagged conversation into an evals-agent case that fails before the fix and passes after it.
    - Nothing goes live without the builder's approval.
    - After an operator answer is approved as knowledge, the same question is answered without a handover.
21. The first contact notice is recorded. Erasing a person removes their messages, facts and tasks, keeping only the minimal log. Export returns everything stored about them. Data older than the retention period is deleted on schedule.
22. Running the skill on a new agent:
    - The grilling session finishes with every branch answered before anything is written.
    - Every section of the prompt template is filled with no placeholders, every tool has both conditions, roles, a risk level and example messages, and the draft passes the skill's best practices checklist (no contradictions, stop conditions stated, a confirm summary for every irreversible tool).
    - The builder gets the agent replying locally by adding creds and running one migrate command, with no hand edits.
    - Adding a tool later meets the same bar for that tool.
23. The core installs as a package, and agents import only from its public entry point.
24. The first agent's evals-agent adapter uses only injected dependencies, with no module mocking and no RPC ports. It passes the adapter checklist: `surface` lists every tool and write, the happy path has zero error effects, and every tool run, gate decision, confirmation and handover shows up as an effect on every brain. Tests can freeze the clock.
25. The README quickstart works on a fresh clone with only API keys set, and a secret scan of the repo comes back clean.
