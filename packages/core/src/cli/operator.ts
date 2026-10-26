// ROLE-2: `openbox operator add <channel> <id>`.
//
// The only way an operator is made, apart from the agent's own seed.
// Never through chat, which is the whole point: an operator can block
// people and read conversations, so the decision belongs to whoever runs
// the agent and not to anything a brain can be talked into.
//
// It takes a channel and an id rather than a name, because that pair is
// what a message arrives with (LOOP-1) and a name is not unique. A person
// who has already written is promoted in place, so their history, facts
// and tasks stay theirs.
import type { SupabaseClient } from "@supabase/supabase-js"
import { ProviderError, supabaseFromEnv, type Env } from "../providers/index.ts"
import { createStore } from "../store/index.ts"
import { loadProject, ProjectError, type LoadProjectOptions } from "./project.ts"
import { stdio, type ChatIo } from "./terminal.ts"

export interface OperatorOptions extends LoadProjectOptions {
  /** The words after `operator`, so `["add", "whatsapp", "9198..."]`. */
  args: string[]
  /** Used as given, so a test needs no environment (DEP-3). */
  db?: SupabaseClient | undefined
  env?: Env | undefined
  io?: ChatIo | undefined
}

const USAGE = "Usage: openbox operator add <channel> <id>"

export async function runOperator(options: OperatorOptions): Promise<number> {
  const io = options.io ?? stdio()
  const [subcommand, channel, id] = options.args

  if (subcommand !== "add") {
    io.write(
      `${
        subcommand === undefined
          ? "openbox operator needs something to do."
          : `openbox operator has no "${subcommand}".`
      } The only thing it does is add.\n${USAGE}\n`,
    )
    return 1
  }

  if (channel === undefined || channel === "" || id === undefined || id === "") {
    io.write(`An operator is a channel and an id on it.\n${USAGE}\n`)
    return 1
  }

  let project: Awaited<ReturnType<typeof loadProject>>
  try {
    project = await loadProject(options)
  } catch (error) {
    if (error instanceof ProjectError) {
      io.write(`${error.message}\n`)
      return 1
    }
    throw error
  }

  let db: SupabaseClient
  try {
    db = options.db ?? supabaseFromEnv(options.env ?? process.env)
  } catch (error) {
    if (error instanceof ProviderError) {
      io.write(`${error.message}\n`)
      return 1
    }
    throw error
  }

  const agent = project.config.name
  const store = createStore(db, agent)
  const existing = await store.people.find({ channel, channel_user_id: id })

  if (existing === null) {
    await store.people.insert({ channel, channel_user_id: id, role: "operator" })
    io.write(`Added ${channel} ${id} as an operator of ${agent}.\n`)
    io.write("They are an operator from their next message on.\n")
    return 0
  }

  const who = existing.display_name === null ? id : `${existing.display_name} (${id})`

  if (existing.role === "operator") {
    io.write(`${who} on ${channel} is already an operator of ${agent}. Nothing to do.\n`)
    return 0
  }

  await store.people.update({ id: existing.id }, { role: "operator" })
  io.write(`Promoted ${who} on ${channel} to an operator of ${agent}.\n`)
  io.write("Their history, facts and tasks are unchanged.\n")
  return 0
}
