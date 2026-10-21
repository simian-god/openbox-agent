// SKILL-6: `openbox chat` starts a local terminal session against the
// agent in the current folder.
//
// It reads the project as it stands (PKG-3), builds the providers from its
// config (DEP-3), attaches the terminal channel and talks. The burst
// window is forced to zero, so a typed line is answered at once instead of
// waiting to see whether more is coming.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { OpenboxConfig } from "../config/index.ts"
import {
  ProviderError,
  providersFromConfig,
  supabaseFromEnv,
  type Env,
} from "../providers/index.ts"
import type { Brain } from "../providers/brains/types.ts"
import type { DecisionModel } from "../providers/decision/types.ts"
import { createAgent } from "../runtime/agent.ts"
import { loadProject, ProjectError, type LoadProjectOptions } from "./project.ts"
import { stdio, terminalChannel, type ChatIo } from "./terminal.ts"

export interface ChatOptions extends LoadProjectOptions {
  /** Who is typing. The same id keeps the same conversation history. */
  as?: string | undefined
  displayName?: string | undefined
  env?: Env | undefined
  io?: ChatIo | undefined
  /** Used as given, so a test needs no key and no network (DEP-3). */
  brains?: Brain[] | undefined
  decisionModel?: DecisionModel | undefined
  db?: SupabaseClient | undefined
  sessionId?: string | undefined
}

/** SKILL-6: a typed line is answered at once, not after a burst window. */
export function chatConfig(config: OpenboxConfig): OpenboxConfig {
  return { ...config, burstWindowMs: 0 }
}

/**
 * Runs a chat session. Returns the exit code, so the CLI can hand it
 * straight to the process, and prints anything that went wrong in words a
 * builder can act on.
 */
export async function runChat(options: ChatOptions = {}): Promise<number> {
  const io = options.io ?? stdio()
  const env = options.env ?? process.env

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

  const config = chatConfig(project.config)

  let brains: Brain[]
  let decisionModel: DecisionModel
  let db: SupabaseClient
  try {
    // One call, so every missing key is reported together rather than one
    // run at a time.
    const built = providersFromConfig(
      config,
      {
        ...(options.brains !== undefined ? { brains: options.brains } : {}),
        ...(options.decisionModel !== undefined ? { decisionModel: options.decisionModel } : {}),
      },
      env,
    )
    brains = built.brains
    decisionModel = built.decisionModel
    db = options.db ?? supabaseFromEnv(env)
  } catch (error) {
    if (error instanceof ProviderError) {
      io.write(`${error.message}\n`)
      io.write("Set the missing keys, then run openbox chat again.\n")
      return 1
    }
    throw error
  }

  const channel = terminalChannel({
    io,
    ...(options.as !== undefined ? { channelUserId: options.as } : {}),
    ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  })

  let agent: ReturnType<typeof createAgent>
  try {
    agent = createAgent({
      config,
      deps: { brains, decisionModel, db, sender: channel.sender },
      prompt: project.prompt,
      tools: project.tools,
    })
  } catch (error) {
    // CFG-1's tool rules and a clashing tool name both land here.
    io.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  // LOOP-2: nothing is handled until the worker runs. Chat is the worker
  // as well as the channel, so it starts one and gives up its leases on
  // the way out.
  agent.start()
  try {
    await channel.run(agent)
  } finally {
    await agent.stop()
  }
  return 0
}
