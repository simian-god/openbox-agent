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

A short grilling on one tool, then written to the same bar as step 4, then
the checklist run over that tool alone. Read the existing tools first: the
commonest fault is a new tool whose conditions overlap one that is already
there, which is checklist item 5.

## `swap`

Change one provider in `agent.config.ts`, nothing else, then run the
agent's own tests against it. A swap is a new version of the agent, so the
version hash moves and that is correct. Report what the tests said rather
than assuring the builder it worked.

## `chat`

A local terminal session against the agent:

```
openbox chat
```

It uses the terminal channel with the burst window at zero, so one message
is one turn. Inside it, `:help` lists its commands.

## `review`

Reads unreviewed flags and the conversations behind them, groups them by
likely cause, proposes each fix as a diff, writes each failure as a draft
evals-agent case, runs the suite before and after, and marks the flags
reviewed with the outcome.

Nothing is applied unless the new cases pass, nothing old regresses, and
the builder approves. All three, every time.

Status: the flagged conversation export is not built yet. If it is
missing, say so and stop rather than hand rolling one.

## `tune`

Measures where the routing threshold belongs, from `examples/routing.jsonl`
and from every tool's own examples:

```
openbox tune --dir <agent>
```

It reports. It writes the one number into config only with `--write`, and
only when the builder asks for it.
