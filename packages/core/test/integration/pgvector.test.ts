// KNOW-4 and DATA-3: the pgvector retriever and its optional migration,
// against the real extension on real Postgres.
//
// What is worth proving here is not that pgvector can compare two vectors.
// It is the three things that are ours: that the table really is optional
// and the core schema does not carry it, that the ranking happens in the
// database rather than in the agent, and that one agent's chunks are never
// returned to another.
//
// The embedder is a stub, because the only real one built is OpenAI and
// that is parked (Known K28 and K9). A short concept vector is padded to
// the column's width, and zero padding leaves cosine similarity unchanged,
// so `[1, 0, 0]` stays readable while still going through a real
// `vector(1536)` column and a real `<=>`.
import { test, expect, beforeAll, beforeEach } from "bun:test"
import { z } from "zod"
import { describeDatabase, dropAllTables, resetDatabase, localSupabase } from "../support/db.ts"
import { trackAgents } from "../support/agents.ts"
import { failure } from "../support/throws.ts"
import type { Agent, AgentOptions } from "../../src/runtime/index.ts"
import { WANTS_HUMAN } from "../../src/runtime/handover.ts"
import { GATE_QUESTION } from "../../src/runtime/gate.ts"
import { defineConfig } from "../../src/config/index.ts"
import { defineTool } from "../../src/tools/index.ts"
import { scriptedBrain, type ScriptedStep } from "../../src/testing/scripted-brain.ts"
import { scriptedDecisionModel, yesno } from "../../src/testing/scripted-decision.ts"
import { fakeSender } from "../../src/testing/fake-sender.ts"
import { fixedClock } from "../../src/testing/clock.ts"
import type { BrainInput } from "../../src/providers/brains/types.ts"
import type { Retriever } from "../../src/providers/retrievers/types.ts"
import { migrate, collectMigrations, tablesWithoutRls } from "../../src/migrate/index.ts"
import {
  pgvectorRetriever,
  PGVECTOR_DIMENSIONS,
  PGVECTOR_TABLE,
} from "../../src/providers/retrievers/pgvector.ts"
import type { Embedder } from "../../src/providers/embedders/types.ts"
import type { KnowledgeDoc } from "../../src/knowledge/index.ts"
import type { SQL } from "bun"

const doc = (id: string, text: string, source = `${id}.md`): KnowledgeDoc => ({ id, text, source })

const DRINKS = doc("drinks", "Drinks\n\nMasala chai and filter coffee.")
const FOOD = doc("food", "Food\n\nDal makhani and paneer tikka.")
const HOURS = doc("hours", "Opening hours\n\nEleven to eleven, every day.")

/** Three chunks pointing three different ways, and the questions to match. */
const VECTORS: Record<string, number[]> = {
  [DRINKS.text]: [1, 0, 0],
  [FOOD.text]: [0, 1, 0],
  [HOURS.text]: [0, 0, 1],
  "what do you have to drink": [1, 0, 0],
  "what food is there": [0, 1, 0],
  "what time do you open": [0, 0, 1],
  // Leans towards the hours and still touches the drinks, so two chunks
  // score above zero and the order between them can be wrong.
  "when do you open, and is there chai": [0.3, 0, 1],
  "chai, and some dal too": [1, 0.5, 0],
}

/** Zero padding does not change cosine, so a short vector can stay short. */
function pad(short: number[]): number[] {
  const out = new Array<number>(PGVECTOR_DIMENSIONS).fill(0)
  short.forEach((value, at) => {
    out[at] = value
  })
  return out
}

/** An embedder that answers from the table above, and records every ask. */
function recording(over: Record<string, number[]> = {}) {
  const asked: string[][] = []
  const embedder: Embedder = {
    id: "fake",
    async embed(texts) {
      asked.push([...texts])
      // Anything unlisted points a fourth way, so it matches nothing above.
      return texts.map((text) => pad({ ...VECTORS, ...over }[text] ?? [0, 0, 0, 1]))
    },
  }
  return { embedder, asked, texts: (): string[] => asked.flat() }
}

const tableNames = async (sql: SQL): Promise<string[]> => {
  const rows = (await sql`
    select tablename from pg_tables where schemaname = 'public' order by tablename
  `) as { tablename: string }[]
  return rows.map((row) => row.tablename)
}

const agents = trackAgents("pgvector.test.ts")
const SECRET = "test-secret-long-enough-to-look-real"

/** One read only tool, so the agent has something besides the search. */
const table = defineTool({
  name: "check_availability",
  description: "Checks whether a table is free.",
  input: z.object({}),
  risk: "read",
  roles: ["end_user"],
  conditions: { callWhen: ["they ask about a table"], dontCallWhen: ["they do not"] },
  examples: { should: ["any space?"], shouldNot: ["hello"] },
  handler: async () => ({ free: true }),
})

/** An agent on the retriever a test hands it. */
function buildAgent(
  script: ScriptedStep[],
  how: { knowledge: KnowledgeDoc[]; retriever: Retriever },
): { agent: Agent; calls: BrainInput[] } {
  const scripted = scriptedBrain(script, { exhaustedReply: "Anything else?" })
  const made: AgentOptions = {
    secret: SECRET,
    config: defineConfig({
      name: "restaurant",
      mode: "development",
      timezone: "Asia/Kolkata",
      hours: { mon: [["11:00", "23:00"]] },
      brain: { id: "openrouter", model: "test/model" },
      decisionModel: { id: "jev" },
      retriever: { id: "pgvector", embedder: "openai" },
      limits: { dailySpendUsd: 5 },
      notice: "We store your messages.",
      retentionDays: 365,
      burstWindowMs: 0,
    }),
    knowledge: how.knowledge,
    deps: {
      brains: [{ id: "scripted", kind: "api", supportsImages: true, complete: scripted.complete }],
      decisionModel: scriptedDecisionModel([
        { [WANTS_HUMAN]: yesno(0), [GATE_QUESTION]: yesno(1) },
      ]),
      db: localSupabase(),
      sender: fakeSender(),
      clock: fixedClock("2026-10-19T07:00:00Z"),
      retriever: how.retriever,
    },
    prompt: "You are the host at a restaurant.",
    tools: [table],
  }
  return { agent: agents.create(made), calls: scripted.calls }
}

const message = (who: string, text: string) => ({
  channel: "whatsapp",
  channelUserId: who,
  channelMessageId: `m-${who}-${text.slice(0, 10)}`,
  text,
})

describeDatabase("the pgvector retriever", (sql) => {
  beforeAll(async () => {
    // The optional migration is not part of the shared schema, by design.
    await migrate({ sql: sql(), pgvector: true })
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  const retrieverFor = (agentId: string, embedder: Embedder) =>
    pgvectorRetriever({ agentId, embedder, sql: sql() })

  test("DATA-3: the core schema does not carry the pgvector table", async () => {
    const names = collectMigrations({}).map((entry) => entry.name)
    expect(names.some((name) => name.includes("vector"))).toBe(false)

    // And really so, not just on paper: a core migrate leaves it out.
    await dropAllTables(sql())
    await migrate({ sql: sql() })

    expect(await tableNames(sql())).not.toContain(PGVECTOR_TABLE)

    // Put it back, because the rest of this file needs it.
    await migrate({ sql: sql(), pgvector: true })
  })

  test("DATA-3: the optional migration creates the table and records itself", async () => {
    await dropAllTables(sql())

    const result = await migrate({ sql: sql(), pgvector: true })

    expect(result.applied).toContain("pgvector/0001_knowledge_chunks.sql")
    expect(await tableNames(sql())).toContain(PGVECTOR_TABLE)
  })

  test("DATA-5: the optional table has row level security switched on", async () => {
    expect(await tablesWithoutRls(sql())).toEqual([])
  })

  test("KNOW-4: the chunk and its embedding are stored in the optional table", async () => {
    const { embedder } = recording()

    await retrieverFor("restaurant", embedder).index([DRINKS])

    const rows = (await sql()`
      select id, source, text, embedding is not null as embedded
      from ob_knowledge_chunks
    `) as { id: string; source: string; text: string; embedded: boolean }[]

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(DRINKS.id)
    expect(rows[0]?.source).toBe("drinks.md")
    expect(rows[0]?.text).toContain("Masala chai")
    expect(rows[0]?.embedded).toBe(true)
  })

  test("KNOW-4: the nearest chunk comes back first, ranked by the database", async () => {
    const { embedder } = recording()
    const retriever = retrieverFor("restaurant", embedder)
    await retriever.index([DRINKS, FOOD, HOURS])

    const found = await retriever.search("when do you open, and is there chai", 3)

    // Two chunks match and the weaker one is still worth returning, so
    // this pins the order rather than only the winner. Orthogonal test
    // vectors hid a missing `order by` here: with one chunk above zero and
    // the rest filtered out, any order looked right.
    expect(found.map((hit) => hit.source)).toEqual(["hours.md", "drinks.md"])
    expect(found[0]?.score).toBeGreaterThan(found[1]?.score ?? 1)
  })

  test("KNOW-3: the text and the source come back with the score", async () => {
    const { embedder } = recording()
    const retriever = retrieverFor("restaurant", embedder)
    await retriever.index([DRINKS, FOOD, HOURS])

    const [best] = await retriever.search("what do you have to drink", 3)

    expect(best?.source).toBe("drinks.md")
    expect(best?.text).toContain("Masala chai")
    expect(best?.score).toBeGreaterThan(0)
  })

  test("KNOW-3: no more than k come back, and the k kept are the best ones", async () => {
    // The query matches the drinks more than the food and the food more
    // than nothing, so asking for one of two proves the cut keeps the
    // better one rather than whichever row Postgres reached first.
    const { embedder } = recording()
    const retriever = retrieverFor("restaurant", embedder)
    await retriever.index([DRINKS, FOOD, HOURS])

    const found = await retriever.search("chai, and some dal too", 1)

    expect(found).toHaveLength(1)
    expect(found[0]?.source).toBe("drinks.md")
  })

  test("KNOW-4: indexing again embeds only what is new", async () => {
    const { embedder, texts } = recording()
    const retriever = retrieverFor("restaurant", embedder)
    await retriever.index([DRINKS, FOOD])

    await retriever.index([DRINKS, FOOD, HOURS])

    // Embedding is what a provider charges for, so re-indexing a folder to
    // add one entry must not pay for the whole folder again.
    expect(texts()).toEqual([DRINKS.text, FOOD.text, HOURS.text])
  })

  test("KNOW-2: a document indexed after a search is found without a restart", async () => {
    const { embedder } = recording()
    const retriever = retrieverFor("restaurant", embedder)
    await retriever.index([DRINKS, FOOD])

    expect(await retriever.search("what time do you open", 3)).toEqual([])

    await retriever.index([HOURS])

    const found = await retriever.search("what time do you open", 3)
    expect(found[0]?.source).toBe("hours.md")
  })

  test("KNOW-2: indexing one document leaves the others searchable", async () => {
    const { embedder } = recording()
    const retriever = retrieverFor("restaurant", embedder)
    await retriever.index([DRINKS, FOOD, HOURS])

    await retriever.index([doc("parking", "Parking\n\nTwo spaces behind.")])

    const found = await retriever.search("what do you have to drink", 3)
    expect(found[0]?.source).toBe("drinks.md")
  })

  test("DATA-1: a search never returns another agent's chunks", async () => {
    const { embedder } = recording()
    await retrieverFor("restaurant", embedder).index([DRINKS, FOOD, HOURS])

    const other = await retrieverFor("dentist", embedder).search("what do you have to drink", 5)

    expect(other).toEqual([])
  })

  test("DATA-1: two agents keep their own copy of the same chunk", async () => {
    // Ids are a hash of the text (KNOW-1), so two agents loading the same
    // file produce the same id. Keyed on the agent too, or one would
    // overwrite the other and DATA-1 would be a filter over one row.
    const { embedder } = recording()
    await retrieverFor("restaurant", embedder).index([DRINKS])
    await retrieverFor("dentist", embedder).index([DRINKS])

    const rows = (await sql()`
      select agent_id from ob_knowledge_chunks where id = ${DRINKS.id} order by agent_id
    `) as { agent_id: string }[]

    expect(rows.map((row) => row.agent_id)).toEqual(["dentist", "restaurant"])
  })

  test("KNOW-4: an embedder whose vectors are the wrong width is reported", async () => {
    // Left unchecked this is the worst kind of bug: pgvector accepts a
    // column with no declared width and then fails at search time instead,
    // long after the wrong data went in.
    const wrong: Embedder = { id: "narrow", embed: async (texts) => texts.map(() => [1, 0, 0]) }

    const error = await failure(() => retrieverFor("restaurant", wrong).index([DRINKS]))

    expect(error.message).toContain(String(PGVECTOR_DIMENSIONS))
    expect(error.message).toContain("narrow")
  })

  test("KNOW-3: a blank query and a k of zero both return nothing, and cost nothing", async () => {
    const { embedder, asked } = recording()
    const retriever = retrieverFor("restaurant", embedder)
    await retriever.index([DRINKS])
    const paidFor = asked.length

    expect(await retriever.search("   ", 5)).toEqual([])
    expect(await retriever.search("what do you have to drink", 0)).toEqual([])

    expect(asked).toHaveLength(paidFor)
  })

  test("DATA-3: an agent configured for pgvector without the migration is told to run it", async () => {
    // The mistake somebody will certainly make, and the raw Postgres error
    // for it says nothing about what to do.
    const { embedder } = recording()
    const retriever = retrieverFor("restaurant", embedder)
    await sql().unsafe("drop table if exists ob_knowledge_chunks")
    await sql()`delete from ob_migrations where name like 'pgvector/%'`

    const searching = await failure(() => retriever.search("what food is there", 5))
    const indexing = await failure(() => retriever.index([DRINKS]))

    // Put it back before asserting, not after. A failed expectation here
    // would otherwise leave the table gone and take every later test in
    // this file down with it, which is how a probe first found this.
    await migrate({ sql: sql(), pgvector: true })

    expect(searching.message).toContain("openbox migrate --pgvector")
    expect(indexing.message).toContain("openbox migrate --pgvector")
  })

  test("KNOW-4: searching an empty table returns nothing rather than failing", async () => {
    const { embedder } = recording()

    expect(await retrieverFor("restaurant", embedder).search("what food is there", 5)).toEqual([])
  })
})

// C18: a question answerable only from a knowledge file, answered on the
// pgvector retriever. The local half of this is in knowledge.test.ts, and
// the criterion says both, so this is the other half.
describeDatabase("C18: an agent answering from its documents on pgvector", (sql) => {
  const PARKING = doc(
    "parking",
    "Parking\n\nThere is a free lot behind the building.",
    "faq.md#Parking",
  )
  const MENU = doc("menu", "Menu\n\nDal makhani and paneer tikka.", "menu.md#Food")

  /** Points the parking question at the parking chunk and nowhere else. */
  const embedder: Embedder = {
    id: "fake",
    async embed(texts) {
      const at: Record<string, number[]> = {
        [PARKING.text]: [1, 0, 0],
        [MENU.text]: [0, 1, 0],
        "where do I park": [1, 0, 0],
      }
      return texts.map((text) => pad(at[text] ?? [0, 0, 1]))
    },
  }

  beforeAll(async () => {
    await migrate({ sql: sql(), pgvector: true })
  })

  beforeEach(async () => {
    await resetDatabase(sql())
  })

  test("C18: the chunk reaches the brain, with the file it came from", async () => {
    const { agent, calls } = buildAgent(
      [
        { tool: "search_knowledge", input: { query: "where do I park" } },
        { reply: "There is a free lot behind the building." },
      ],
      {
        knowledge: [PARKING, MENU],
        retriever: pgvectorRetriever({ agentId: "restaurant", embedder, sql: sql() }),
      },
    )

    await agent.receiveAndWait(message("9", "where do I park?"))

    const handed = JSON.stringify(calls[1]?.messages.at(-1))
    expect(handed).toContain("free lot behind the building")
    expect(handed).toContain("faq.md#Parking")
  })

  test("C18: the documents really went to Postgres, not to an index in memory", async () => {
    const { agent } = buildAgent([{ reply: "Hello." }], {
      knowledge: [PARKING, MENU],
      retriever: pgvectorRetriever({ agentId: "restaurant", embedder, sql: sql() }),
    })

    await agent.receiveAndWait(message("9", "hello"))

    const rows = (await sql()`
      select source from ob_knowledge_chunks where agent_id = 'restaurant' order by source
    `) as { source: string }[]
    expect(rows.map((row) => row.source)).toEqual(["faq.md#Parking", "menu.md#Food"])
  })
})
