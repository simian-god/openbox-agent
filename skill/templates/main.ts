// What runs in production: wires the providers, the database and the
// channels, starts the workers, and gives up its leases on the way out.
//
// Everything here is the same whatever the agent does. The parts that
// differ are the config, the prompt, the tools and the channel glue.
//
//   bun run main.ts
//
// Several copies of this can run against one database. That is the safe
// way to add throughput: one person is answered by exactly one process at
// a time, decided by a lease in the database rather than by luck
// (DATA-4).
import {
  createAgent,
  loadKnowledge,
  loadProject,
  providersFromConfig,
  supabaseFromEnv,
} from "openbox-agent"
// {{end_user_channel}} and {{operator_channel}}: the glue the skill wrote
// in `channels/`. Each exports a `Sender` and the mapping from whatever
// the channel delivers to an `Inbound`.
import channel from "./channels/whatsapp.ts"

// The config, the prompt and every tool, read from the project itself, so
// adding a tool is adding a file and nothing here changes.
const project = await loadProject()

// One call, so every missing key is reported together rather than one run
// at a time. Keys come from the environment, never from config (CFG-2).
const providers = providersFromConfig(project.config)

const agent = createAgent({
  config: project.config,
  prompt: project.prompt,
  tools: project.tools,
  // KNOW-1: the agent's own documents, read once at startup, out of the
  // project's `knowledge/` folder.
  knowledge: loadKnowledge(project.dir),
  deps: {
    brains: providers.brains,
    decisionModel: providers.decisionModel,
    retriever: providers.retriever,
    db: supabaseFromEnv(),
    sender: channel.sender,
  },
  // CONF-3: signs the Confirm and Cancel buttons, so one person's button
  // cannot be used by anyone else. Required only for an agent with an
  // irreversible tool, and `createAgent` says so plainly when it is
  // missing.
  secret: process.env["OPENBOX_SECRET"],

  // {{alerting}}: where these go. A log line is enough to start with, and
  // anything that pages somebody belongs here rather than inside a tool.
  //
  // onTurnError is the one worth wiring first: a turn that failed in a way
  // the core did not plan for is the one case where the person may not
  // have been answered (docs/Known.md K30).
  onTurnError: (failure) => console.error("turn failed", failure),
  onWorkerError: (error) => console.error("worker error", error),
  onEventError: (failure) => console.error("event not recorded", failure),
})

// LOOP-2: nothing is handled until the workers run. Until this line the
// agent only writes messages down.
agent.start()

// Registered before anything blocks, because a handler added after the
// server is listening is a handler that is never added.
//
// A process that exits without stopping leaves whoever it was answering
// leased until that lease expires, which looks to them like an agent that
// went quiet for no reason. `stop()` finishes the turns in flight, gives
// the leases back, and waits at most `stopTimeoutMs` before saying so
// (Known K27).
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void agent.stop().then(() => process.exit(0))
  })
}

// {{serving}}: how messages arrive, and the line this process sits on. A
// webhook channel listens, a polling channel polls, and the terminal
// channel reads the keyboard. The glue owns that, because only it knows
// what the channel sends.
await channel.serve(agent)
