# Spec: openbox-agent

What the core and the `/openboxagent` skill do, precisely enough to build and test against. Every section names the Intent goals it serves (G1 to G25). Every requirement has an ID (like LOOP-3) so tests and the review can point at it.

Defaults marked *(default)* are starting values, set in config and tuned with real data.

---

## 1. Words

| Word | Meaning |
|---|---|
| Builder | The person who builds an agent with the skill. |
| Person | Anyone who messages the agent. A person is one channel plus their ID on that channel. |
| End user / operator | The two roles a person can have. Role lives in the database. |
| Turn | Everything the agent does in response to one batch of incoming messages from one person. |
| Step | One brain call inside a turn. A turn has one or more steps. |
| Brain | The LLM that writes replies and proposes tool calls. |
| Decision model | The small model that routes, gates and scores (Jev, OpenAI Decisions API, Laya). |
| Tool | Something the agent can do. Agent tools are written per agent; built in tools ship with the core. |
| Risk | Every tool is `read`, `write` or `irreversible`. |
| Gate | The decision model's check of a proposed `write` or `irreversible` call against the tool's conditions. |
| Pending action | An irreversible call waiting for a structured confirm. |
| Task | A multi turn piece of work, like a booking, with fields collected so far. |
| Handover | A period where an operator, not the brain, talks to a person. |
| Flag | A marker on a turn saying it's worth reviewing. |
| Job | Anything scheduled: reminders, expiries, timeouts, retention, the digest. |

---

## 2. Package and project shape (G1, G23)

**PKG-1.** The core is one npm package, `openbox-agent`, with a single public entry point. Agents import nothing else from it.

**PKG-2.** The public entry exports: `createAgent`, `defineTool`, `defineConfig`, the provider factories (brains, decision models, transcribers, retrievers, embedders), `providersFromConfig`, the `openbox` CLI, the testing fakes, and all public types.

**PKG-3.** An agent project, as written by the skill, looks like this:

```
my-agent/
  agent.config.ts        typed config (section 19)
  prompt.md              static system prompt, fixed headings (section 20)
  tools/*.ts             one file per agent tool
  knowledge/*.md         documents for search_knowledge
  examples/routing.jsonl labeled messages per tool
  db/migrations/*.sql    the agent's own tables
  db/seed.ts             starter data
  channels/*.ts          glue for each end user and operator channel
  main.ts                wires providers and starts the agent
```

**PKG-4.** The core's own tables ship as SQL migrations inside the package. `openbox migrate` applies core migrations, then the agent's, in order.

---

## 3. Runtime API (G1, G13, G16, G21, G24)

```ts
const agent = await createAgent(config, deps)

agent.start()                          // starts the inbox worker, outbox worker and job loop
agent.stop()                           // finishes in flight work, releases leases

agent.receive(inbound)                 // writes to the inbox, returns at once: { inboxId, duplicate }
agent.receiveAndWait(inbound)          // same, then waits until the resulting turn and its sends finish

agent.inFlight()                       // how many turns this process is running
agent.settled()                        // resolves once none are. stop() waits on the same thing

agent.schedule(message)                // a proactive message at a time (section 12)
agent.trigger(event)                   // a proactive message from an outside event (section 12)

agent.erase(personId, by)              // section 16
agent.export(personId)                 // section 16
```

**API-1.** `receive` must return within 100 ms of the database write, so webhooks can acknowledge fast.

**API-2.** `receiveAndWait` resolves only after the turn ends and every outbound message from it has reached a final send state. evals-agent adapters use this for `say()`.

### Inbound

```ts
type Inbound = {
  channel: string               // "whatsapp", "telegram", "web", ...
  channelUserId: string         // the sender's ID on that channel
  channelMessageId: string      // used to drop duplicates
  receivedAt?: Date             // defaults to clock.now()
  text?: string
  media?: { kind: "audio" | "image" | "file"; ref: string; mime: string; caption?: string }[]
  action?: { payload: string }  // a button tap, passed through untouched
  displayName?: string
}
```

**API-3.** The glue never passes a role. Role comes only from the database (ROLE-1).

---

## 4. Injected dependencies (G2, G3, G17, G18, G24)

```ts
type Deps = {
  brains: Brain[]               // first is primary, the rest are fallbacks in order
  decisionModel: DecisionModel
  transcriber?: Transcriber
  retriever: Retriever
  db: SupabaseClient            // supabase-js client
  sender: Sender                // implemented by the channel glue
  clock: { now(): Date }
  events?: { capture(event: string, props: Record<string, unknown>): void }
}
```

**DEP-1.** The core reaches the outside world only through these. No module level clients, no direct `fetch` outside a provider.

### Brain

```ts
interface Brain {
  id: string
  kind: "api" | "cli"
  supportsImages: boolean
  complete(input: {
    model: string
    system: string                       // static prompt + runtime block
    messages: BrainMessage[]
    tools: { name: string; description: string; inputSchema: JSONSchema }[]
  }): Promise<{
    text?: string
    toolCalls?: { name: string; input: unknown }[]
    finishReason: string
    usage: { inputTokens: number; outputTokens: number; costUsd?: number }
  }>
}
```

This is the shape evals-agent's existing `wrapLlm` already captures.

A `BrainMessage` is one entry in the history LOOP-7 describes: the messages
with this person, then this turn's tool calls and their results.

```ts
type BrainMessage =
  | { role: "person"; text: string; images?: { ref: string; mime: string }[] }
  | { role: "agent"; text: string }
  | { role: "operator"; text: string }
  | { role: "notice"; text: string }
  | { role: "tool_call"; id: string; name: string; input: unknown }
  | { role: "tool_result"; id: string; name: string; result: unknown; error?: string }
```

`operator` and `notice` carry the author LOOP-7 lists, so a brain can tell a
human's words from its own. Adapters map them onto whatever roles their API
offers. `id` ties a result to the call that asked for it.

**BRAIN-1.** Brains that ship at launch:

| Brain | Kind | How it's called |
|---|---|---|
| OpenRouter | api | Native tool calling over HTTP. |
| Claude Agent SDK | api | API key, no built in tools, custom system prompt, structured output, one turn. Spawns its own bundled executable per call, so it is slower than a direct API call and needs a JS runtime on the machine. Still `api` rather than `cli`: it needs no separately installed command, and BRAIN-4 is about a brain that drives the builder's own tooling. |
| OpenAI Agents SDK | api | API key, structured output, one turn. **Parked**, see the decisions log for 2026-10-26. Its id and env key stay reserved, config still accepts it, and `providersFromConfig` says plainly that the adapter is not built. OpenAI's models are reachable through OpenRouter in the meantime, and the OpenAI Decisions API is unaffected. |
| Claude Code CLI | cli | `claude -p` with prompt on stdin, `--bare --tools "" --system-prompt <text> --json-schema <schema> --output-format json --no-session-persistence --system-prompt-snapshot off --model <m>`. Needs `ANTHROPIC_API_KEY`: under `--bare` it never reads a logged in session. |
| Codex CLI | cli | `codex exec -` with prompt on stdin, `--output-schema <file> -o <file> --sandbox read-only --skip-git-repo-check --ephemeral --ignore-user-config -m <m>`. It has no system prompt flag, so the system goes in front of the conversation on stdin, and no way to have no tools. Uses its own login; a key is passed only when one is set. |

**BRAIN-2.** Brains without native tool calling return this structured shape, which the adapter turns into `text` or one `toolCalls` entry:

```json
{ "kind": "reply" | "tool", "text": "...", "tool": "<one of the offered names>", "args": { } }
```

**BRAIN-3.** If a brain returns more than one tool call, the core takes the first and records the rest as dropped.

**BRAIN-4.** CLI brains are for building and local testing only. `createAgent` refuses a config with `mode: "production"` that lists a CLI brain.

**BRAIN-5.** Fallback. On a timeout, an error, or output that fails BRAIN-2's shape twice in a row, the step moves to the next brain in the list. Any error, including one that is not a `BrainError`: an adapter with a bug costs the person their answer exactly as an outage does, and the brain, the error and the fallback are all recorded either way. The turn records which brain answered, and the fallback is per step, so a provider that was down for a moment does not cost the rest of the turn. A turn that runs out of brains leaves its inbox rows findable rather than done (LOOP-12).

### Decision model

```ts
interface DecisionModel {
  id: string
  ask(state: unknown, questions: Record<string, Question>): Promise<{
    answers: Record<string, Answer>
    usage: { inputTokens: number; costUsd?: number }
  }>
}

type Question =
  | { type: "choice"; instructions: string; options: Record<string, string | null> }
  | { type: "score"; instructions: string; levels: string[] }
  | { type: "yesno"; instructions: string; whenTrue?: string; whenFalse?: string }

type Answer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number }
  | { type: "yesno"; p: number }
```

**DM-1.** Adapters at launch: Jev (TypeSafe API or OpenRouter) and OpenAI Decisions API. A model with more than one route takes `route` in config, and `model` pins its version (section 19). Laya later. Each adapter maps these three types onto the vendor's own (Jev: choice, score, noul; OpenAI: choice, score, predicate).

**DM-2.** All questions for one step go in one request, so the state is paid for once.

**DM-3.** A choice over more than 255 options is split into groups of at most 255, and a second choice runs over the group winners.

### Transcriber, retriever, embedder

```ts
interface Transcriber { id: string; transcribe(media: { ref: string; mime: string }): Promise<{ text: string; language?: string }> }
interface Retriever  { id: string; index(docs: KnowledgeDoc[]): Promise<void>; search(query: string, k: number): Promise<{ text: string; source: string; score: number }[]> }
interface Embedder   { id: string; embed(texts: string[]): Promise<number[][]> }
```

**DEP-2.** Transcribers at launch: Sarvam and OpenAI. Retrievers at launch: `local`, which runs in process (keyword search, plus embeddings when an embedder is configured), and pgvector.

**DEP-3.** `main.ts` builds the deps from config with `providersFromConfig(config)`, which reads keys from the environment. Tests and evals-agent pass their own instances instead, and those win. Either way, each turn records the IDs of the providers that actually ran.

### Sender

```ts
interface Sender {
  capabilities(channel: string): {
    buttons: boolean
    files: boolean
    templates: boolean
    windowHours?: number          // e.g. 24 for WhatsApp
    idempotentSends: boolean      // the channel can safely receive the same send twice
  }
  send(out: Outbound): Promise<
    | { status: "sent"; channelMessageId: string }
    | { status: "rejected"; retryable: boolean; error: string }
  >                               // a thrown timeout means the outcome is unknown
}
```

**SEND-1.** The outbox acts on the three outcomes like this:

| What `send` did | Outbox row | Tried again |
|---|---|---|
| `sent` | `sent`, with the channel's message id | no |
| `rejected`, `retryable: true` | `queued`, `not_before` pushed out by the backoff | up to `sendAttempts`, then `failed` |
| `rejected`, `retryable: false` | `failed`, recorded as `send_failed` | no |
| threw | `unknown`, recorded as `send_unknown` | only when the channel declares `idempotentSends` |

**SEND-2.** A thrown send is `unknown`, not `failed`. The request went out and no answer came back, so the message may well have arrived, and sending it again would say it twice. Saying something twice to a person is worse than not knowing whether it landed. `idempotentSends` is the only thing that changes this: on such a channel a repeat cannot be seen by the person, so it is tried again.

**SEND-3.** Retries are `sendAttempts` *(5 default)* with the wait doubling from `sendBackoffMs` *(1000 default)*, jittered, which is about thirty seconds in all. A very late reply is often worse than none in a conversation, because the person has already asked someone else.

**SEND-4.** A person receives messages in the order they were queued. One person's outbox is sent one message at a time; different people are sent at once.

```ts

type Outbound = {
  channel: string; channelUserId: string
  text?: string
  buttons?: { label: string; payload: string }[]
  template?: { name: string; vars: Record<string, string> }
  file?: { url: string; name: string; mime: string }
  idempotencyKey: string
}
```

---

## 5. Data (G4, G6, G13, G14, G16, G20, G21)

**DATA-1.** Every core table has `agent_id`, and every core query filters on it.

**DATA-2.** Core tables, each prefixed `ob_` in the database (`ob_people`, `ob_inbox` and so on) so they never clash with an agent's own tables:

| Table | Holds |
|---|---|
| `people` | channel, channel_user_id, role, display_name, language, blocked, opted_out, notice_shown_at. Unique on (agent_id, channel, channel_user_id). |
| `person_leases` | Which process is handling a person, and until when. |
| `inbox` | Every incoming message: channel_message_id, text, media, action, status (`pending`, `merged`, `done`, `failed`), turn_id. Unique on (agent_id, person_id, channel_message_id). |
| `turns` | person, version, brains used, steps, cost, latency, outcome. |
| `messages` | The conversation: direction, author (`person`, `agent`, `operator`, `notice`), text, transcript, media ref, channel. |
| `facts` | key and value per person. Unique on (agent_id, person_id, key). |
| `tasks` | type, fields, missing, status (`open`, `active`, `done`, `cancelled`, `expired`), expires_at. |
| `pending_actions` | tool, args, args_hash, summary, code, status (`pending`, `confirmed`, `executed`, `failed`, `cancelled`, `expired`), expires_at, task_id. |
| `tool_runs` | tool, args, result, status (`ok`, `error`, `blocked`, `needs_confirmation`, `pending`), the step it ran on, duration. |
| `decisions` | Every decision model call: kind (`route`, `gate`, `frustration`, `wants_human`), the outcome the core reached from it, answers, model, the step, duration, cost. |
| `outbox` | Every outgoing message: payload, kind (`reply`, `proactive`, `operator_alert`, `confirm`), status (`queued`, `sending`, `sent`, `failed`, `unknown`), attempts, idempotency_key (unique), not_before, urgent. |
| `jobs` | kind, run_at, payload, status, lease, attempts, dedupe_key (unique). |
| `handovers` | person, status (`waiting`, `active`, `closed`, `unanswered`), reason, operator, timestamps. |
| `operator_focus` | Which handover each operator is currently replying in. |
| `flags` | turn, person, kind, detail, reviewed_at, review_outcome. |
| `knowledge_entries` | Operator answers: question, answer, status (`candidate`, `approved`, `rejected`), source handover, approved_by. |
| `versions` | Hash of prompt, tools and config, with when it was first seen. |
| `events` | The full trace of section 18. |
| `erasure_log` | Hashed person reference, when, by whom. Nothing else. |

**DATA-3.** The schema uses plain Postgres DDL: tables, primary and foreign keys, unique constraints, check constraints, indexes and sequences. A sequence is how the tables that record a run of things, `ob_messages`, `ob_inbox` and `ob_events`, keep the order those things happened in, which a timestamp cannot do once two rows share an instant. No triggers, stored functions or extensions. pgvector tables live in a separate, optional migration used only by the pgvector retriever.

**DATA-5.** RLS is switched on for every table, core and agent. On Supabase, a table without RLS can be read and written by anyone holding the project's public anon key, which often ships inside a frontend. Core tables get no policies, so only the service key the agent runs with can reach them. Agent tables get no policies either, unless the builder says something else reads them (a website showing the menu, say), in which case the skill writes a policy for exactly that. Core behavior never depends on RLS, so the eval world, which ignores it, behaves the same.

**DATA-6.** After applying migrations, `openbox migrate` checks every table in the schema and fails with the table's name if any has RLS switched off.

**DATA-4.** Every concurrent claim (person lease, job, outbox row, pending action status) is one conditional `UPDATE ... WHERE <expected state> RETURNING`, issued through supabase-js filters. No RPCs.

---

## 6. Identity and roles (G5, G12)

**ROLE-1.** A message from an unknown (channel, channel_user_id) creates a person with role `end_user`. Nothing in a message can change a role.

**ROLE-2.** Operators are created or promoted only by the builder: `openbox operator add <channel> <id>` or the seed. Never through chat.

**ROLE-3.** Every tool declares `roles`. Before routing, the core removes every tool the person's role can't use. A call to a removed tool is rejected like an unknown tool (LOOP-8).

**ROLE-4.** A blocked person's messages are stored and get no reply.

---

## 7. The turn (G8, G10, G11, G13, G15, G19)

### Receiving

**LOOP-1.** `receive` finds or creates the person and inserts an inbox row. A unique key violation means a duplicate: it returns `{ duplicate: true }` and nothing else happens.

**LOOP-2.** A worker claims a person with pending inbox rows by taking their lease. While the lease is held, no other process handles that person. The lease lasts 60 s *(default)* and is renewed while the turn runs.

**LOOP-3.** The worker waits until the burst window (3 s *(default)*, 0 in tests) has passed since that person's latest inbox row. It then takes every pending row for that person into one turn, in arrival order.

**LOOP-4.** Rows that arrive during a turn wait for the next turn. When a turn ends with pending rows still present, the worker starts the next turn straight away.

### Before the brain

**LOOP-5.** Checks run in this order. The first one that applies decides the turn:
1. Person is blocked: store, no reply (ROLE-4).
2. Text is exactly `STOP` or `START` (any case): set or clear `opted_out` and send a fixed confirmation.
3. Rate limit hit (LIMIT-1): fixed reply, operator alert.
4. Spend cap hit (LIMIT-3): treat as a handover trigger.
5. Person is in an active or waiting handover: store, forward to the operator (HAND-5), no brain.
6. Inbound has a button payload, or text that exactly matches a live pending action's code: run the confirm path (section 9), then continue to the brain with the result.
7. First contact: queue the notice (PRIV-1) ahead of the reply.

**LOOP-6.** Audio is transcribed (MEDIA-1). Images go to the brain when it supports them (MEDIA-2).

### Context

**LOOP-7.** The brain gets:
- **System:** `prompt.md`, then a runtime block with the current date, time, weekday and timezone, the person's role, channel, language and facts, their open tasks (marking the active one), their pending actions, and the opening hours for today and tomorrow.
- **Messages:** the last 30 *(default)* messages with this person (person, agent, operator and notice), then the current batch, then this turn's tool calls and results. Tool results from earlier turns aren't resent; facts and tasks carry that state.

### Steps

**LOOP-8.** Each step:
1. **Decide.** One decision request (DM-2). On the first step it also asks `wants_human` (HAND-1) and `frustration` (LEARN-1). Routing runs only when the agent has more than 5 *(default)* agent tools for this role (ROUTE-1).
2. **Expose tools.** All built in tools for the role, plus the agent tools from routing (ROUTE-2).
3. **Brain.** Call the brain (with fallback, BRAIN-5).
4. **Reply.** A reply ends the turn.
5. **Tool call.** If the name isn't among the exposed tools, the call is rejected and the brain is told which tools exist. It's never executed, and it's recorded as `unknown_tool`.
6. **Validate.** Arguments are checked against the tool's schema. Failures go back to the brain as an error result.
7. **Built in tools** run straight away (section 10).
8. **Read tools** run straight away.
9. **Write and irreversible tools** go through the gate (section 8).
10. **Results** go back to the brain as the input to the next step.

**LOOP-9.** A turn has at most 8 steps *(default)*. On the limit, the person gets a fixed "let me check and come back to you" reply, the turn is flagged, and an operator is alerted.

**LOOP-10.** Tools run with a timeout of 15 s *(default)*. A timeout or a thrown error goes back to the brain as an error result. The same tool failing twice in a row for the same person, within this turn or across turns, is a handover trigger.

### Ending

**LOOP-11.** The reply goes to the outbox. The turn records its version, the brains used, steps, cost and latency, then the lease is released.

**LOOP-12.** If every brain fails, the person gets the fixed holding message and an operator is alerted. The inbox rows stay linked to the failed turn, so nothing is lost.

---

## 8. Routing and gating (G7, G8, G19)

### Conditions

**TOOL-1.** Every agent tool is defined with:

```ts
defineTool({
  name: "create_booking",
  description: "Books a table.",
  input: z.object({ ... }),                 // zod schema
  risk: "read" | "write" | "irreversible",
  roles: ["end_user"],                      // and/or "operator"
  conditions: {
    callWhen: ["The person has given a date, time and party size", "..."],
    dontCallWhen: ["The person is only asking about availability", "..."],
  },
  confirmSummary: (args) => `Table for ${args.size} on ${args.date} at ${args.time}`,  // required for irreversible
  examples: { should: ["..."], shouldNot: ["..."] },
  handler: async (args, ctx) => { ... },
})
```

**TOOL-2.** Registration fails with a clear error when: `callWhen` or `dontCallWhen` is empty, `roles` is empty, `examples.should` or `examples.shouldNot` is empty, an irreversible tool has no `confirmSummary`, or a name clashes with a built in tool.

**TOOL-3.** The description the brain sees is the tool's `description`, then "Call when:" with its `callWhen` lines, then "Don't call when:" with its `dontCallWhen` lines.

**TOOL-4.** The handler gets `ctx`: the person, their facts, `clock`, the time helpers (TIME-2), the agent's own tables through `db`, `sendFile`, and `log`.

### Routing

**ROUTE-1.** Routing is a choice question. The options are every agent tool the role allows, each described by TOOL-3's text, plus `no_tool` ("Answer from the conversation and knowledge, no action needed"). The state is the last 6 messages, the current batch, and the active task.

**ROUTE-2.** What the brain gets:
- **Top pick at or above the threshold:** the top tools, in order, until their combined probability reaches 0.9, at most 3.
- **`no_tool` on top at or above the threshold:** no agent tools.
- **Top pick below the threshold:** every agent tool the role allows.
- **Agent has 5 or fewer tools for this role:** no routing, every tool the role allows.

**ROUTE-3.** Routing runs on every step, so after one tool's result the next step can route to another (check availability, then book).

**ROUTE-4.** The threshold is set per decision model in config, starting at 0.6 *(default)*. `openbox tune` measures it from `examples/routing.jsonl` and reviewed decisions (LEARN-5). It reports the lowest threshold at which the right tool is still exposed for all but a chosen share of the labeled examples, `--tolerance`, 1 in 100 *(default)*. Lowest, because every step above it is a turn paying full price for a tool list it did not need. A recommendation that narrows almost nothing is reported as routing not being worth asking for, rather than as a tuned threshold.

**ROUTE-5.** If the decision model fails or times out (`decisionTimeoutMs`, 3 s *(default)*), the step proceeds as if confidence were below the threshold, and records `fallback_used`. Nothing is retried: a step has seconds in total, so the person's wait is not spent on an optimisation.

### Gate

**GATE-1.** Before a `write` or `irreversible` call runs, the core asks a yes/no question: "This call meets the tool's call when conditions and none of its don't call when conditions, given the conversation." The state holds the tool's conditions, the proposed arguments, the last 6 messages and the active task.

**GATE-2.** The probability falls into a band, set per tool per decision model:

| Band | `write` *(default)* | `irreversible` *(default)* | Result |
|---|---|---|---|
| Pass | p ≥ 0.7 | p ≥ 0.85 | `write`: runs. `irreversible`: a pending action is created (section 9). |
| Confirm | 0.4 ≤ p < 0.7 | 0.5 ≤ p < 0.85 | Not run. The brain is told the call needs the person's confirmation, quoting the condition in doubt. |
| Block | p < 0.4 | p < 0.5 | Not run. The brain is told it's blocked and why. The turn is flagged. |

**GATE-3.** Two blocks in a row, or two routing picks below the threshold in a row, for the same person is a handover trigger.

**GATE-4.** If the decision model fails, the gate fails closed. A `write` call is treated as Confirm. An `irreversible` call still needs a structured confirm, which never depends on the decision model.

**GATE-5.** `read` tools are never gated. Reading at the wrong moment is harmless, and role filtering (ROLE-3) already controls who can read what.

---

## 9. Structured confirmation (G9)

**CONF-1.** Passing the gate on an `irreversible` call creates a pending action. It holds the tool, its arguments, a hash of those arguments, the `confirmSummary` text, a random 4 digit code, the person, the active task, and an expiry 15 minutes *(default)* out.

**CONF-2.** The core sends the confirm message itself, not the brain: the summary, plus a Confirm and a Cancel button when the channel has buttons, or "Reply <code> to confirm" when it doesn't. The brain is told a confirmation was requested and must not say the action is done.

**CONF-3.** Button payloads look like `ob1.<verb>.<actionId>.<signature>`, where the verb is `c` for Confirm or `x` for Cancel. The signature is an HMAC of the verb, action ID and person ID, keyed with `OPENBOX_SECRET` from the environment.

**CONF-4.** A confirm runs the action only if every one of these holds:
- the signature is valid, or the typed code matches exactly
- it came from the same person who created the action
- the action is still `pending` and not expired
- the arguments' hash hasn't changed

Anything else is rejected, recorded as `confirmation_rejected`, and the person is told the request expired or doesn't match.

**CONF-5.** Execution claims the action with a conditional update from `pending` to `confirmed`. Two taps run it once.

**CONF-6.** A new pending action on the same task cancels the old one. So does the brain changing the task's fields.

**CONF-7.** The confirm logic lives in the core. Per agent, the skill writes only `confirmSummary` and the button rendering in the channel glue.

**CONF-8.** A valid Cancel from the same person, or the text `cancel` while an action is pending, sets it to `cancelled`, and the brain is told. A cancel for an action that already ran changes nothing, and the person is told it already went through.

---

## 10. Built in tools (G4, G11, G12, G14, G18)

| Tool | Roles | What it does |
|---|---|---|
| `remember` | end_user | Saves or updates a fact about the person: `{ key, value }`. |
| `forget_fact` | end_user | Removes a fact when the person asks. |
| `start_task` | end_user | Opens a task of a declared type with any fields already known. It becomes the active task. |
| `update_task` | end_user | Sets fields on a task. The core recomputes `missing` from the task type. |
| `switch_task` | end_user | Makes another open task the active one. |
| `close_task` | end_user | Marks a task done or cancelled. |
| `search_knowledge` | both | Searches knowledge files and approved knowledge entries. |
| `escalate` | end_user | Starts a handover with a reason. |
| `take_over` | operator | Takes an open handover, or starts one for a named person. |
| `resume` | operator | Ends the handover and gives the person back to the bot. |
| `block` / `unblock` | operator | Blocks or unblocks a person. |
| `approve_knowledge` / `reject_knowledge` | operator | Decides on a knowledge candidate. |
| `flag` | operator | Flags a conversation for review. |
| `list_handovers` | operator | Lists waiting and active handovers. |
| `erase_person` | operator | Erases a person (section 16). This one is `irreversible`, so it needs the operator's structured confirm. |
| `export_person` | operator | Sends the operator a file with everything stored about a person. |

**BUILTIN-1.** Built in tools skip routing. Only `erase_person` is gated and confirmed.

**BUILTIN-2.** Task types are declared in config with their fields and which fields are required. `missing` is always computed by code, never written by the brain.

**BUILTIN-3.** Tasks expire after 24 h *(default)* without changes. Expiry also expires their pending actions.

---

## 11. Handover (G11, G12)

**HAND-1.** Triggers:
- `escalate` called by the brain
- the decision model's `wants_human` is at or above 0.8 *(default)*
- GATE-3 or LOOP-10's repeat rules
- the spend cap (LIMIT-3)
- an operator's `take_over`

**HAND-2.** On a trigger, a handover opens as `waiting`. The person gets a short fixed message saying a person will reply. Every operator gets an alert with the person's name, channel, the reason, and a three line summary written by the brain from the last messages. Writing the summary is the brain's only job in a handover.

**HAND-3.** The first operator to `take_over` makes it `active`. The other operators are told who took it.

**HAND-4.** While an operator's focus is on an active handover, any message from them that doesn't start with `/` is relayed word for word to the person. No brain, no routing. Messages starting with `/` go to the agent as operator commands, through the brain and operator tools.

**HAND-5.** While a handover is `waiting` or `active`, the person's messages are stored and forwarded to the focused operator, or to all operators while it's waiting.

**HAND-6.** If a handover stays `waiting` for 10 minutes *(default)*, the person is told someone will get back to them, and it becomes `unanswered`. It stays open, and the alert is repeated hourly *(default)* during opening hours (config `hours`).

**HAND-7.** An `active` handover returns to the bot on `resume`, or after 30 minutes *(default)* with no message from either side. When it returns, the brain gets a note that a handover happened, with the operator's messages in the history.

**HAND-8.** When an operator answers something during a handover, the core saves the person's question and the operator's answer as a knowledge `candidate` (LEARN-6).

---

## 12. Proactive messages (G16)

```ts
agent.schedule({ personId, at, text?, template?, compose?, urgent?, dedupeKey })
agent.trigger({ personId, event: "order_ready", data: { ... }, urgent? })
```

**PRO-1.** Scheduled messages are jobs, so they survive restarts. `dedupeKey` makes scheduling the same reminder twice a no op.

**JOB-1.** A job is claimed by one conditional update (DATA-4) and runs under a lease, the same way a person is. A job a process claimed and never finished is taken over once that lease expires, by a second conditional update rather than an OR.

**JOB-2.** A job that throws is tried again, the wait doubling from `jobBackoffMs` *(5000 default)*, up to `jobAttempts` *(5 default)*, then `failed`. A job of a kind with no registered handler fails at once, since waiting cannot make a handler appear. Jobs are more patient than sends: nobody is waiting at the other end of a retention sweep.

**JOB-3.** The job loop also hands back messages a turn took and never finished with. A process killed mid turn leaves them `merged`, and nothing else looks at those: a second worker takes the person over when the lease expires, but only looks for messages still `pending`. They are handed back once that person's lease has been expired for `recoverAfterSeconds` *(60 default)*, which is the margin for a process that stalled rather than died.

**JOB-4.** A reply's idempotency key is derived from the messages it answers, not from the turn. A recovered message is answered by a different turn, so a key based on the turn would let both replies out and answer the person twice.

**PRO-2.** A proactive message is either fixed (`text` or `template`) or composed: the brain runs a turn with a system note describing the event, using the same tools and gates.

**PRO-3.** Before sending, the outbox checks these in order:
1. **Opted out:** dropped and recorded.
2. **Quiet hours** (21:00 to 09:00 in the agent's timezone *(default)*) and not urgent: `not_before` moves to the end of quiet hours.
3. **Outside the channel's window** (`windowHours` since the person's last message): only a `template` is sent. A free text message with no template becomes `failed` and flagged.

**PRO-4.** Replies to the person's own messages aren't proactive, so quiet hours and opt out don't apply to them.

---

## 13. Time (G15)

**TIME-1.** All time comes from the injected clock. Nothing in the core or in generated tools reads the system clock directly.

**TIME-2.** Tools get time helpers in `ctx.time`, all in the agent's timezone:
- `resolve(phrase)`: turns "tomorrow 8pm", "next Friday" or "in 2 hours" into an exact time, or returns `ambiguous` with the candidates.
- `isOpen(at)` and `nextOpen(after)`: computed from the config's `hours` and exceptions.
- `format(at)`: how a time is written back to the person.

**TIME-3.** Tool inputs that hold a time take a plain English phrase ("tomorrow 8pm"), never a date the brain worked out. If the person used another language ("kal raat 8 baje"), the brain translates the words into English but doesn't calculate anything. The tool resolves them with `ctx.time.resolve` and checks opening hours in code. An ambiguous phrase goes back to the brain so it can ask the person.

**TIME-4.** The runtime block shows today's and tomorrow's dates with their weekdays, so the brain can talk about them. The prompt tells the brain never to calculate dates itself.

---

## 14. Media and language (G17)

**MEDIA-1.** Audio goes to the transcriber. The transcript is stored on the message and used as its text. The audio isn't stored, only the channel's media reference. With no transcriber, or on failure, the person is asked to type instead.

**MEDIA-2.** Images go to the brain when `supportsImages` is true. Otherwise the person gets a fixed reply saying images can't be read, with the caption used as text if there is one. The decision model always works from text: the transcript or caption.

**MEDIA-3.** The person's language is detected from the transcriber or the brain and stored on the person. The runtime block tells the brain to reply in it unless `prompt.md` says otherwise.

**MEDIA-4.** Tools send files through `ctx.sendFile`, which goes through the outbox. It's only allowed when the channel's `files` capability is true.

---

## 15. Knowledge (G18)

**KNOW-1.** At start, the core loads every file in `knowledge/`, splits it into chunks of about 500 words on heading boundaries, adds every `approved` knowledge entry, and indexes them in the retriever.

**KNOW-2.** Approving a knowledge entry adds it to the index at once, with no restart.

**KNOW-3.** `search_knowledge` returns the top 5 *(default)* chunks with their source file or entry.

**KNOW-4.** The `local` retriever uses keyword ranking. When an embedder is configured, it combines keyword and embedding scores. The pgvector retriever stores chunks and embeddings in its optional table.

---

## 16. Limits and personal data (G10, G21)

**LIMIT-1.** Rate limit: 20 messages per person per 10 minutes *(default)*. Beyond it, one fixed reply per window, then silence, plus an operator alert.

**LIMIT-2.** Step cap: LOOP-9.

**LIMIT-3.** Daily spend cap per agent, in USD. It's required in config, with no default. Spend is the sum of brain, decision model and transcriber costs for the current day in the agent's timezone, using provider reported cost when available and the config's pricing table otherwise. At the cap, every new turn becomes a handover trigger until midnight.

**PRIV-1.** On a person's first contact, the notice text from config goes out before the first reply, and `notice_shown_at` is set. Config without notice text fails to load.

**PRIV-2.** A daily job deletes messages, events, tool runs and decisions older than the retention period, and facts not updated within it. The retention period is required in config.

**PRIV-3.** Erasing a person deletes their messages, facts, tasks, pending actions, handovers, flags and the person row. Their inbox rows and events keep only IDs, timestamps and event names; all text and payloads are cleared. One row goes into `erasure_log` with a hash of the person reference. `erase` is idempotent.

**PRIV-4.** Export returns one JSON document with everything stored about the person.

---

## 17. Learning (G20)

**LEARN-1.** Flags are raised automatically on:

| Flag | When |
|---|---|
| `handover` | Any handover starts. |
| `gate_block` | Any gate Block. |
| `low_confidence` | A routing pick below the threshold. |
| `tool_error` | Any tool error or timeout. |
| `unknown_tool` | The brain called a tool that wasn't exposed. |
| `frustration` | The frustration score is at or above 1.5 on a 0 to 2 scale (calm, annoyed, angry) *(default)*. |
| `step_cap` | LOOP-9 fired. |
| `confirmation_rejected` | CONF-4 rejected a confirm. |
| `send_blocked` | A message could not be sent because of a channel rule, such as free text outside the channel's window (PRO-3). |
| `operator` | An operator used `flag`. |

**LEARN-2.** Every turn stores its version ID: a hash of `prompt.md`, every tool's name, description, conditions, schema, risk and roles, the config without secrets, and the core package version.

**LEARN-3.** Every Monday at 09:00 *(default)* in the agent's timezone, a digest goes to the builder's channel (set in config): flag counts by kind compared with the week before, spend, median latency, and the five worst conversations ranked by number of flags.

**LEARN-4.** The skill's `review` command:
1. reads unreviewed flags and their conversations
2. groups them by likely cause: missing knowledge, wrong routing, conditions too strict or too loose, prompt gap, tool bug, or a missing tool
3. proposes a fix for each group as a diff
4. writes each failure as a draft evals-agent case (schema 1), for the builder to edit
5. runs the suite before and after the fix
6. applies the fix only when the new cases pass, nothing old regresses, and the builder approves
7. marks the flags reviewed with the outcome

**LEARN-5.** Every routing decision the builder reviews is appended to `examples/routing.jsonl` with its correct tool. A line is `{ "text", "tool" }`, or `{ "messages", "batch", "tool" }` when the right tool depends on the conversation. `openbox tune` recomputes the thresholds from that file and from every tool's own `should` and `shouldNot` examples (TOOL-1), so a new agent has a labeled set before it has any traffic, and reports accuracy per decision model. It asks the decision model once per distinct question, not once per label and never once per candidate threshold, and measures every threshold against the recorded answers. It changes config only when asked (LEARN-7).

**LEARN-6.** Knowledge candidates from handovers wait for an operator's `approve_knowledge` before they're searchable.

**LEARN-7.** Nothing in this section changes the agent without the builder's approval, except operator approved knowledge entries.

---

## 18. Events (G24)

**EVT-1.** Every step of the turn writes to the `events` table and calls `deps.events.capture(name, props)` when it's given. That's the same shape evals-agent's capturing analytics already records.

**EVT-2.** Event names:

| Group | Events |
|---|---|
| Turns | `turn_started`, `turn_ended` |
| Inbox | `duplicate_dropped`, `burst_merged` |
| Routing and gating | `route_decided`, `gate_passed`, `gate_confirm`, `guard_block` (a Block, named to match evals-agent's effect kind), `unknown_tool` |
| Confirmation | `pending_action_created`, `confirmation_received`, `confirmation_rejected`, `pending_action_executed`, `pending_action_expired` |
| Tools | `tool_ran` |
| Handover | `handover_started`, `handover_taken`, `handover_ended`, `handover_unanswered` |
| Limits and failures | `limit_hit`, `fallback_used` |
| Media and knowledge | `transcribed`, `knowledge_searched` |
| Outbox | `send_failed`, `send_unknown` |
| Flags and jobs | `flag_raised`, `job_ran` |

**EVT-3.** Brain calls aren't events. They're visible because evals-agent wraps `Brain.complete` directly.

---

## 19. Config (G2, G3, G10, G15, G16, G21)

```ts
export default defineConfig({
  name: "restaurant",
  mode: "development" | "production",
  timezone: "Asia/Kolkata",
  hours: { mon: [["11:00", "23:00"]], /* ... */ exceptions: [{ date: "2026-10-20", closed: true }] },

  brain: { id: "openrouter", model: "...", fallbacks: [{ id: "openai-agents", model: "..." }] },
  decisionModel: {
    id: "jev",
    route: "openrouter",               // DM-1: which route, for a model that has more than one
    model: "typesafe/jev-1.14",        // optional, pins the version
    routeThreshold: 0.6,
    gateBands: { /* per tool overrides */ },
  },
  transcriber: { id: "sarvam" },
  retriever: { id: "local", embedder: null },

  history: 30,
  burstWindowMs: 3000,
  routingMinTools: 5,
  decisionTimeoutMs: 3000,             // ROUTE-5
  maxSteps: 8,
  leaseSeconds: 60,                    // LOOP-2
  workerPollMs: 1000,                  // how often a worker looks for waiting messages
  workerConcurrency: 4,                // how many people one process answers at once
  sendAttempts: 5,                     // SEND-3
  sendBackoffMs: 1000,                 // SEND-3
  jobAttempts: 5,                      // JOB-2
  jobBackoffMs: 5000,                  // JOB-2
  recoverAfterSeconds: 60,             // JOB-3
  limits: { messagesPerWindow: 20, windowMinutes: 10, dailySpendUsd: 5 },  // dailySpendUsd required
  pricing: { "model-id": { inputPerM: 0, outputPerM: 0 } },

  handover: { noOperatorMinutes: 10, idleMinutes: 30, alertRepeatMinutes: 60, wantsHumanThreshold: 0.8 },  // HAND-6
  pendingActionMinutes: 15,
  quietHours: ["21:00", "09:00"],
  taskTypes: { booking: { fields: { date: "required", time: "required", size: "required", notes: "optional" }, idleHours: 24 } },

  notice: "...",                       // required
  retentionDays: 365,                  // required
  builderChannel: { channel: "telegram", channelUserId: "..." },
})
```

**CFG-1.** The config is validated when the agent starts. Missing required fields, unknown provider IDs, a CLI brain in production, or an irreversible tool without `confirmSummary` all stop the start with a clear message.

**CFG-2.** Secrets never go in config. Providers read keys from the environment.

---

## 20. The `/openboxagent` skill (G22)

**SKILL-1.** One skill, invoked as `/openboxagent`, with these commands: `new`, `add-tool`, `swap`, `chat`, `review`, `tune`. With no command, it asks which one.

**SKILL-2.** Before writing anything, every command reads `references/best-practices.md` (Anthropic's context engineering guidance and OpenAI's agentic prompting guidance, condensed) and `references/checklist.md`.

**SKILL-3.** `new` works like this:
1. Checks the grilling skill is installed, and stops with the install command if it isn't.
2. Grills the builder using grilling's rounds. The top branches of the question tree are the prompt template's headings, the tools, the data, the channels, the operators, and personal data (SKILL-11). It asks for API docs whenever a tool touches an outside system.
3. Writes nothing until the frontier is empty and the builder confirms shared understanding.
4. Writes the full project (PKG-3). That includes every tool with its risk, roles, conditions, `confirmSummary` and at least 5 `should` and 5 `shouldNot` examples, plus the end user and operator channel glue with confirm buttons.
5. Runs the checklist over its own output and shows the result.
6. Tells the builder exactly which env vars to set, then the commands to run: `openbox migrate`, then `openbox chat`.

**SKILL-4.** `add-tool` runs a short grilling on one tool, then writes it to the same bar and runs the checklist on it.

**SKILL-5.** `swap` changes a provider in config and runs the agent's tests on the new one.

**SKILL-6.** `chat` starts a local terminal session against the agent, using a terminal channel with the burst window at zero.

**SKILL-7.** `review` is LEARN-4. `tune` is LEARN-5.

**SKILL-8.** `prompt.md` has these headings, in this order:
1. Identity and goal
2. Business context
3. Who you're talking to (end users and operators)
4. How to use tools
5. Confirmations and irreversible actions
6. Rules and boundaries
7. When to hand over
8. Style and language
9. When a turn is done
10. Examples

**SKILL-9.** The checklist covers at least:
- no contradictions between sections
- no placeholder text
- stop conditions stated
- every irreversible tool has a confirm rule and summary
- no two tools whose `callWhen` lines overlap without a `dontCallWhen` that separates them
- dates handled by tools, not the prompt
- handover rules match `HAND-1`
- every tool's examples agree with its conditions
- the prompt doesn't restate per tool rules that belong in conditions
- every agent table has RLS on, and any policy matches a reader the builder named

**SKILL-10.** The skill ships channel glue templates for WhatsApp Cloud API, Telegram Bot API, Discord and a generic web webhook. Each implements `Inbound` mapping and `Sender` with honest `capabilities`.

**SKILL-11.** `new` asks about personal data before it writes config, because `notice` and `retentionDays` are required and have no defaults, so there is no number to fall back on. It asks:

1. What this agent will end up holding about a person, read back from the tools and tables already discussed rather than asked cold.
2. How long conversations, audit records and stored facts should be kept.
3. What the first contact notice should say. The skill drafts one from the answers above and the builder edits it.
4. How somebody asks to be erased or to get a copy, and which operator can do it.
5. Whether any of this is health, financial, government ID or children's data.

A yes to 5 stops the flow: the skill says plainly that this is a stricter category, that it cannot tell the builder what the rules require, and that the answer belongs to a lawyer. It then writes the project with the builder's own numbers and carries on.

**SKILL-12.** Whatever the builder answered goes into `docs/privacy.md` in the agent's project, with the date, the numbers chosen, the categories named in SKILL-11.5, and one line saying these were the builder's decisions and have not been reviewed by a lawyer. The skill never writes a number the builder did not give it, and never says an agent is compliant.

---

## 21. Testability (G24)

**TEST-1.** An evals-agent adapter needs only:
- `schemaFiles`: core migrations, then the agent's
- `seed`: the agent's `db/seed.ts`
- `open(ctx)`: `createAgent` with the harness's capturing brain, `db` and `events`, a fake sender that emits `outbound_msg`, `outbound_template` and button messages, and a fixed clock
- `say(text)`: `receiveAndWait`
- `inject("button", payload)`: `receiveAndWait` with `action`

**TEST-2.** Nothing in the core requires module mocking or RPC ports to run under evals-agent.

**TEST-3.** The core's own test suite runs without network, using a scripted fake brain and a scripted fake decision model.

---

## 22. Repo and release (G25)

**REL-1.** One public repo under the MIT license, holding the core package, the skill, and a minimal example agent with two tools. The example exists for the README quickstart and the core's end to end tests. It isn't a real product.

**REL-2.** `.env.example` lists every environment variable. No secret is ever committed, and a secret scan runs in CI and before every release.

**REL-3.** An installer links `skill/` into `~/.claude/skills/openboxagent` and `~/.codex/skills/openboxagent`, like evals-agent's. It ships as both a PowerShell and a POSIX script.

**REL-4.** The package follows semver. A breaking change to `Brain`, `DecisionModel`, `Sender`, the tool definition or the core tables needs a major version, plus a migration where tables change.

**REL-5.** The README covers what it is, the quickstart, building an agent with the skill, writing an evals-agent adapter (TEST-1), and the open items from section 23.

---

## 23. To verify during the build

- The exact request and response fields of the OpenAI Decisions API. It's in beta, and only secondary sources were read.
- ~~Structured output support in the Claude Agent SDK~~, in one turn mode with no built in tools. Checked at T5.2 against `@anthropic-ai/claude-agent-sdk@0.3.310`: `outputFormat: { type: "json_schema", schema }` is supported and the answer arrives as `structured_output` on the result message rather than as assistant text. It spawns a subprocess per call. Three of its defaults have to be overridden: `settingSources` loads the machine's own Claude settings and CLAUDE.md unless given `[]`, `env` replaces the subprocess environment rather than merging, and its list of built in tool names is documented as incomplete so tools must be denied with an empty allow list rather than a deny list.
- Structured output support in the OpenAI Agents SDK TypeScript package, in one turn mode with no built in tools. Not checked: the brain is parked, so the question is parked with it.
- ~~Which Claude Code flags combine cleanly~~. Checked at T5.4 against `claude 2.1.306` and the installed `codex`. `--bare` does more than this Spec claimed: it also skips CLAUDE.md auto-discovery, plugins, LSP and auto-memory. It also says "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain are never read)", so a CLI brain needs a key and cannot run on a logged in subscription. `--tools ""` is documented as disabling all tools, and `--json-schema` takes inline JSON; both need `-p`. Codex is a different shape: its schema is a file, its answer is written to a file, and it has no way to turn its tools off, so `--sandbox read-only` is the most that can be done and it still reads the filesystem. That no built in tool leaks in is checked by a live test rather than by reading, since only running it can tell.
- WhatsApp template and button rules at build time.
- sqlite-vec support in evals-agent's world, before any agent relies on the pgvector retriever.
- ~~Whether evals-agent's SQLite world handles the conditional `UPDATE ... RETURNING` claims in DATA-4.~~ Answered at T2.6: its shim builds the statement with every filter the core uses, so DATA-4's claims hold there. The line should have been struck then.
