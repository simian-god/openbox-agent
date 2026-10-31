---
name: openboxagent
description: Build and change a conversational agent on openbox-agent. Use when the builder wants a new agent, a new tool on an existing one, a provider swapped, a local chat with their agent, a review of what went wrong, or the routing thresholds measured.
---

# /openboxagent

Builds agents on `openbox-agent`, a core where an irreversible action runs
only if that person confirmed that exact action, and a message is never
lost, never answered twice and never answered by two servers at once.

The core owns the hard parts. Your job is the agent's own words, tools,
data and channels. Never write around the core: if something here seems to
need gating, confirmation, retries, handover or date arithmetic in a
prompt, the core already does it and you are about to add a second answer
to one question.

## Before anything is written

Read both of these first, every time, whichever command you were given:

- `references/best-practices.md` - the two vendors' prompting guidance
  condensed, and the list of what the core already does so you leave it
  out of the prompt.
- `references/checklist.md` - the bar everything you write is held to.

Then read what exists: `agent.config.ts`, `prompt.md`, `tools/` and
`db/migrations/` if the project already has them. Write nothing until you
have.

## Choosing a command

With no command, ask which one and stop. Do not guess, and do not start
`new` on an existing project.

| Command | What it does |
|---|---|
| `new` | grills the builder, then writes a whole agent project |
| `add-tool` | one more tool on an existing agent, to the same bar |
| `swap` | changes a provider in config and runs the agent's tests on it |
| `chat` | a local terminal session against the agent |
| `review` | turns flagged conversations into fixes and test cases |
| `tune` | measures where the routing threshold belongs |

## `new`

### 1. Check the grilling skill is installed

`new` is a grilling session that ends in a project, so without grilling it
cannot start. Look for `grilling/SKILL.md` under `~/.claude/skills/`, under
`~/.claude/plugins/cache/*/*/*/skills/`, or under `~/.codex/skills/`.

If it is not there, stop and give the builder the install command for
whichever host you are:

- Claude Code: `/plugin marketplace add mattpocock/skills` then
  `/plugin install mattpocock-skills`
- Codex: clone `github.com/mattpocock/skills` and copy its
  `skills/grilling` into `~/.codex/skills/grilling`

Stop means stop. Do not interview the builder yourself instead.

### 2. Grill the builder

Use grilling's own rounds: a design tree, the frontier asked a round at a
time, every question numbered with your recommended answer. The top
branches are:

- the headings in `references/prompt-template.md`, which are the agent's
  identity, context, who it talks to, tools, confirmations, boundaries,
  handover, style, when a turn is done and examples
- the tools
- the data it stores
- the channels
- the operators
- personal data, which is the round below and comes before any config is
  written

Finding facts is your job, not the builder's. Whenever a tool touches an
outside system, ask for its API docs and read them before writing the
tool. Do not ask the builder what an API returns.

### 3. Write nothing yet

Nothing is written until the frontier is empty and the builder confirms
shared understanding. A half answered tree becomes a half right agent that
reads as a finished one.

### 4. Write the whole project

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

Every tool gets a `risk` level, its `roles`, its `callWhen` and
`dontCallWhen` conditions, a `confirmSummary` if it is irreversible, and at
least 5 `should` and 5 `shouldNot` example messages. The channel glue
covers the end user channel and the operator channel, with confirm buttons
where the channel has them.

Start from `templates/`, which has a config, a tool, a migration, a seed,
a `main.ts` and the channel glue already written. `templates/channels/`
covers WhatsApp Cloud API, Telegram, Discord, a generic web webhook and
the terminal, each with its own webhook verification, its tap handling
and honest `capabilities`. Copy the ones this agent serves and delete the
rest. Each one carries its own holes, marked
`{{like_this}}` in a comment next to a sample the skill replaces. Four
values in the config template are deliberately impossible, so an agent
whose privacy round was skipped refuses to start rather than running on
numbers nobody chose.

`prompt.md` uses the prompt template's headings in its order, with every
hole filled from the builder's own answers. Every migration switches row
level security on, in the same file that creates the table, or
`openbox migrate` refuses to finish (DATA-5).

### 5. Run the checklist

Run every item in `references/checklist.md` over what you just wrote, then
show the builder the result item by item, pass or fail. A fail is reported,
not quietly fixed. The builder decides what changes.

### 6. Hand it over

Tell the builder exactly which keys to put in `.env`, naming each one, then
the two commands in order:

```
openbox migrate
openbox chat
```

Nothing else, and no hand edits. If it needs one, your output was
incomplete and that is yours to fix.

## The personal data round

Asked inside `new`, before `agent.config.ts` is written, because `notice`
and `retentionDays` are required and have no defaults: there is no number
to fall back on. Five questions, in this order.

1. What this agent will **end up holding** about a person. Read it back
   from the tools and tables already discussed rather than asking cold.
2. **How long** conversations, audit records and stored facts should be
   kept.
3. What the **first contact notice** should say. Draft one from the two
   answers above and let the builder edit it.
4. How somebody asks to be **erased** or to get a copy of their data, and
   which operator can do it.
5. Whether any of this is health, financial, government ID or children's
   data.

A yes to the fifth stops the round. Say plainly that this is a stricter
category, that you cannot tell the builder what the rules require, and
that the answer belongs to a lawyer. Then carry on and write the project
with the builder's own numbers.

Whatever was answered goes in the agent's own `docs/privacy.md`: the date,
the numbers chosen, the categories named in question 5, and one line saying
these were the builder's decisions and have not been reviewed by a lawyer.

Never write a number the builder did not give you. Never say an agent is
compliant with anything.

## `add-tool`

One more tool on an agent that already runs. A short grilling, the same
bar as step 4, then the checklist.

**Read what is there first.** `agent.config.ts`, `prompt.md` and every
file in `tools/`. The commonest fault in a new tool is conditions that
overlap a tool already there, which is checklist item 5, and an overlap
cannot be seen in the new tool alone.

**Grill on one tool.** Step 1's check still applies: no grilling skill, no
`add-tool`. One round is usually enough. What the tool does, when it must
be called, when it must not, what it hands back, who may call it, how bad
a wrong call is, and what it does when the system behind it is down. If it
touches an outside system, ask for the API docs and read them. Write
nothing until that round is answered.

**Write it to the same bar.** A `risk` level, its `roles`, `callWhen` and
`dontCallWhen`, a `confirmSummary` if it is irreversible, and at least
5 `should` and 5 `shouldNot` examples. Start from `templates/tools/tool.ts`.

**Nothing to register.** Every `.ts` file in `tools/` is loaded and every
tool it exports is kept, so the file is the registration. One tool per
file, as a default export. A name that clashes with an existing tool stops
the agent at startup rather than quietly winning.

**What a new tool brings with it.**

- A table of its own needs a new file in `db/migrations/`, numbered after
  the last, switching row level security on in the same file (DATA-5).
- The first irreversible tool on an agent means `OPENBOX_SECRET` has to be
  in the environment. Without it the agent refuses to start. Say so.
- Routing now has one more option, so run `openbox tune` and report what
  it says. The number is written only with `--write`, and only if the
  builder asks.
- Do not describe the tool in `prompt.md`. A per tool rule there is a
  second answer to a question its conditions already answer, which is
  checklist item 9.

**Then the checklist**, over the new tool, and item 5 over every tool,
because an overlap is a fact about a pair. Show the builder the result
item by item. A fail is reported, not quietly fixed.

The agent's version hash moves, because its tools are part of it. That is
correct: it is a different agent now.

## `swap`

One provider changes in `agent.config.ts`. Nothing else does.

The fields a swap touches are `brain` with its `fallbacks`,
`decisionModel` with its `route`, `transcriber` and `retriever`. An id the
core does not know is refused at startup, so a typo never reaches a
person.

**Name the key the new provider reads.** Keys come from the environment,
never from config (CFG-2):

| Provider | Key |
|---|---|
| `openrouter`, and Jev through OpenRouter | `OPENROUTER_API_KEY` |
| `claude-agent-sdk`, `claude-code-cli` | `ANTHROPIC_API_KEY` |
| `openai-agents`, `codex-cli`, `openai-decisions`, the `openai` embedder | `OPENAI_API_KEY` |
| Jev on its own route | `TYPESAFE_API_KEY` |
| `sarvam` | `SARVAM_API_KEY` |
| the `pgvector` retriever | `DATABASE_URL`, plus `openbox migrate --pgvector` |

Every missing key is reported in one message at startup, so start the
agent and read that list rather than guessing one at a time.

**Three things a swap can break quietly.**

- A CLI brain in production is refused, as the primary and as a fallback:
  `claude-code-cli` and `codex-cli` drive a command on the machine.
- A model the provider reports no cost for, and that config's `pricing`
  does not list, counts as zero against the daily spend cap, so the cap
  stops biting. Add the model to `pricing`, or tell the builder plainly
  that spend is now undercounted.
- A CLI or SDK brain spawns a process per call, so a step takes seconds
  rather than under a second. `brainTimeoutMs` is the knob.

**Then run what there is to run, and say which.**

| Swapped | What to run |
|---|---|
| `brain` | the conformance suite, `runConformance` from `openbox-agent`: one scripted conversation, thirteen checks that must pass, judged on what the agent did rather than how it worded it |
| `decisionModel` | `openbox tune --dir .`, because a different model answers differently and the threshold may belong somewhere else |
| `retriever` or `transcriber` | nothing is shipped for these. Ask the same handful of real questions in `openbox chat` before and after, and compare |

The suite is a call, not a command, so write the five lines rather than
inventing a test of your own. It brings its own secret and needs no
`OPENBOX_SECRET`:

```ts
const config = conformanceConfig({ id: "openrouter", model: "the/new-model" })
const { brains, decisionModel } = providersFromConfig(config)
const report = await runConformance({ config, brains, decisionModel, db: supabaseFromEnv() })
```

`report.passed` decides it, and `report.failed` names what did not.

The conformance suite proves a brain can drive an agent. It **does not
prove this agent still works**, because it brings its own prompt and its
own two tools. For that, chat to it, and run the project's evals-agent
cases if it has any. A fresh project has none, and `review` is what writes
them.

Report what the tests said. Do not tell the builder it worked.

A swap is a new version of the agent, so its version hash moves and every
turn records the version it ran under. That is correct, and it is what
makes a swap visible in the trace later.

## `chat`

A local terminal session against the agent, from the project folder:

```
openbox chat
```

It uses the terminal channel with the burst window forced to zero, so one
typed line is one turn. The command sets that, not the config.

**What has to be in place.** `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` for the database, `openbox migrate` run once
against it, the provider keys above, and `OPENBOX_SECRET` if the agent has
an irreversible tool. Each missing one is named in a message rather than a
stack trace.

**Inside the session.**

```
:help      this list
:version   the version this agent is running
:trace     what the last turn recorded
:quit      leave
```

Anything else is a message. A line starting with `/` is a message too, so
an operator's commands can be typed through. Buttons print numbered, and
typing the number taps one, which is how a confirmation is tried without a
real channel.

`--as <id>` is who is typing, and the same id keeps the same history. An
operator session needs `openbox operator add terminal <id>` first: a role
is never granted in chat (ROLE-2).

**What to look for**, because this is the part no test covers. Does it ask
for a missing detail instead of guessing it. Does an irreversible action
stop and ask. Does it stop when the turn is done instead of carrying on.
Does it sound like the business. Read `:trace` to see which tools ran,
rather than trusting the reply to tell you.

## `review`

Turns what went wrong into a fix and a test case. Seven steps, in this
order, and step 6 is the one that cannot be skipped.

Read `references/eval-case.md` first: it is the case format, and a case the
harness refuses is a case nobody runs.

### 1. Read the backlog

```
openbox review --json
```

Unreviewed flags, oldest first, grouped by a cause proposed from the
trace: missing knowledge, wrong routing, conditions too strict or too
loose, a prompt gap, a tool bug, a missing tool, or `unclear`.

The cause is proposed, not decided. `unclear` means the trace could not
say, and a group can be wrong, so read the conversation before you act on
one:

```
openbox review show <flag-id> --json
```

### 2. Group them yourself

Keep, split or move the proposed groups once you have read the
conversations. Flags on the same turn are listed together, because one
fault usually raises several and fixing them one at a time is the same
work three times.

### 3. Propose each fix as a diff

One diff per group, not per flag. Say which flags it answers. A wrong
routing group is usually a `dontCallWhen` line, not a prompt change;
`references/best-practices.md` says what belongs where.

### 4. Write each failure as a case

One draft case per failure, in `evals/cases/<id>.yaml` in the agent
project, in the format `references/eval-case.md` gives. Draft means the
builder edits it. Never write a real person's words, name or number into
one: a case file is a file, and the retention period in config does not
reach it.

A corrected routing decision is evidence, so record it:

```
openbox review label <flag-id> --tool <name>
```

That appends one line to `examples/routing.jsonl`, which is what `tune`
measures. The same conversation is never labeled twice.

### 5. Run the suite before and after

Before, so a case that was already failing is not read as something this
fix broke. After, on the same cases.

### 6. Apply only if all three hold

The new cases pass, nothing old regresses, and the builder approves. All
three, every time, and if you cannot run the suite then you cannot apply
the fix: say so and stop (LEARN-7).

### 7. Mark the flags reviewed

```
openbox review mark <flag-id> ... --outcome "what came of it"
```

In your own words, because a count of reviewed flags with no outcomes is
no record at all. A flag somebody reviewed first keeps their outcome and
is named in the reply rather than overwritten.

## `tune`

Measures where the routing threshold belongs, from `examples/routing.jsonl`
and from every tool's own `should` and `shouldNot` examples, so a new agent
can be tuned before it has any traffic:

```
openbox tune --dir <agent>
```

It reports. `--tolerance` is the share of examples that may lose their
tool, 1 in 100 by default, and the number it reports is the lowest
threshold inside that: every step above it is a turn paying full price for
a tool list it did not need.

It writes the one number into `agent.config.ts` only with `--write`, and
only when the builder asks for it (LEARN-7). Report what it said either
way, including a recommendation that narrows almost nothing, which is
routing not being worth asking for rather than a tuned number.

Run it after `review` has labeled anything, and after `add-tool`, because
both change what there is to measure.
