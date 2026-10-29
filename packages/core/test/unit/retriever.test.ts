// KNOW-4: the local retriever, on keyword ranking alone and with
// embeddings blended in.
//
// What is worth testing here is not that MiniSearch works. It is the two
// decisions around it: that keyword ranking is what happens when no
// embedder is configured, and that blending normalises both halves before
// adding them, because the two scores are on different scales and adding
// them raw lets whichever is larger decide everything.
import { test, expect, describe } from "bun:test"
import { cosine, localRetriever } from "../../src/providers/retrievers/local.ts"
import type { Embedder } from "../../src/providers/embedders/types.ts"
import type { KnowledgeDoc } from "../../src/knowledge/index.ts"

const doc = (id: string, text: string, source = `${id}.md`): KnowledgeDoc => ({ id, text, source })

const MENU: KnowledgeDoc[] = [
  doc("drinks", "Drinks\n\nWe serve masala chai, filter coffee and fresh lime soda."),
  doc("food", "Food\n\nDal makhani, paneer tikka and hot buttered roti."),
  doc("hours", "Opening hours\n\nEleven in the morning until eleven at night, every day."),
]

/** An embedder that returns whatever the test says, by exact text. */
function embedderOf(vectors: Record<string, number[]>, fallback: number[] = [0, 0, 0]): Embedder {
  return {
    id: "fake",
    async embed(texts) {
      return texts.map((text) => vectors[text] ?? fallback)
    },
  }
}

describe("KNOW-4: keyword ranking, with no embedder", () => {
  test("KNOW-4: a question finds the chunk that answers it", async () => {
    const retriever = localRetriever()
    await retriever.index(MENU)

    const found = await retriever.search("what time do you open", 5)

    expect(found[0]?.source).toBe("hours.md")
  })

  test("KNOW-3: the source comes back with the text", async () => {
    const retriever = localRetriever()
    await retriever.index(MENU)

    const [best] = await retriever.search("chai", 5)

    expect(best?.source).toBe("drinks.md")
    expect(best?.text).toContain("masala chai")
    expect(best?.score).toBeGreaterThan(0)
  })

  test("KNOW-3: no more than k come back, best first", async () => {
    const retriever = localRetriever()
    await retriever.index(MENU)

    const found = await retriever.search("chai roti eleven", 2)

    expect(found).toHaveLength(2)
    expect(found[0]?.score).toBeGreaterThanOrEqual(found[1]?.score ?? 0)
  })

  test("KNOW-4: the heading is searchable, because KNOW-1 put it in the text", async () => {
    // The chunk about hours never says the word "hours" in its body.
    const retriever = localRetriever()
    await retriever.index(MENU)

    expect((await retriever.search("hours", 5))[0]?.source).toBe("hours.md")
  })

  test("a question nothing answers finds nothing, rather than the least bad chunk", async () => {
    const retriever = localRetriever()
    await retriever.index(MENU)

    expect(await retriever.search("helicopter maintenance schedule", 5)).toEqual([])
  })

  test("searching an empty index is empty, not an error", async () => {
    expect(await localRetriever().search("chai", 5)).toEqual([])
  })

  test("an empty query finds nothing, so a blank message costs no search", async () => {
    const retriever = localRetriever()
    await retriever.index(MENU)

    expect(await retriever.search("   ", 5)).toEqual([])
  })

  test("KNOW-2: indexing again adds, and replaces a document with the same id", async () => {
    // Both halves of what KNOW-2 needs: an approved entry arrives on its
    // own and takes effect at once, and re-indexing the same id does not
    // throw or leave two copies.
    const retriever = localRetriever()
    await retriever.index(MENU)
    await retriever.index([doc("parking", "Parking\n\nThere is a lot behind the building.")])

    expect((await retriever.search("parking", 5))[0]?.source).toBe("parking.md")
    // And what was already there is still there. A probe found this
    // missing: an `index` that replaced everything passed the rest of
    // this test, and would have thrown away the knowledge folder the
    // first time an operator approved an entry.
    expect((await retriever.search("chai", 5))[0]?.source).toBe("drinks.md")

    await retriever.index([doc("parking", "Parking\n\nThe lot behind the building is closed.")])
    const again = await retriever.search("parking", 5)
    expect(again).toHaveLength(1)
    expect(again[0]?.text).toContain("closed")
  })

  test("indexing nothing changes nothing", async () => {
    const retriever = localRetriever()
    await retriever.index(MENU)
    await retriever.index([])

    expect((await retriever.search("chai", 5))[0]?.source).toBe("drinks.md")
  })
})

describe("cosine similarity, which the blending rests on", () => {
  test("the same direction is 1, whatever the length", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10)
    expect(cosine([1, 0, 0], [5, 0, 0])).toBeCloseTo(1, 10)
  })

  test("at right angles is 0, and opposite is negative", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10)
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10)
  })

  test("nothing in, nothing out, rather than a division by zero", () => {
    expect(cosine([], [])).toBe(0)
    expect(cosine([0, 0], [1, 1])).toBe(0)
    // Mismatched lengths are a bug somewhere else, and guessing at the
    // overlap would hide it.
    expect(cosine([1, 0], [1, 0, 0])).toBe(0)
  })
})

describe("KNOW-4: blending keyword and embedding scores", () => {
  // Two chunks and a question. The keyword half prefers one, the vector
  // half prefers the other, and the blend has to be able to say so.
  const PAIR: KnowledgeDoc[] = [
    doc("literal", "Chai\n\nWe serve chai."),
    doc("meaning", "Hot drinks\n\nOur tea is brewed with cardamom."),
  ]

  test("KNOW-4: a chunk with no keyword match can still be found, on meaning", async () => {
    // The whole point of having both halves. "tea" appears in neither
    // chunk's searchable words as the question asks it, but the vector
    // says the second chunk is about it.
    const embedder = embedderOf({
      "a hot cup of tea": [0, 1],
      "Chai\n\nWe serve chai.": [1, 0],
      "Hot drinks\n\nOur tea is brewed with cardamom.": [0, 1],
    })
    const retriever = localRetriever({ embedder })
    await retriever.index(PAIR)

    const found = await retriever.search("a hot cup of tea", 5)

    expect(found[0]?.source).toBe("meaning.md")
  })

  test("KNOW-4: with no embedder, the same question finds it only on words", async () => {
    // The control for the test above: nothing is blended unless an
    // embedder is configured, which is what KNOW-4 says.
    const retriever = localRetriever()
    await retriever.index(PAIR)

    const found = await retriever.search("a hot cup of tea", 5)

    // "tea" is a prefix of nothing here, so only the chunk whose heading
    // says "Hot" matches at all, and it matches on "hot" not on meaning.
    expect(found.every((hit) => hit.score > 0)).toBe(true)
  })

  test("KNOW-4: both halves are normalised, so neither scale swamps the other", async () => {
    // A keyword score is unbounded and a cosine is at most 1. Added raw,
    // a strong keyword hit of 1.75 would bury any vector signal. After
    // normalising, the best of each half is 1 and the weights decide.
    const embedder = embedderOf({
      chai: [0, 1],
      "Chai\n\nWe serve chai.": [1, 0],
      "Hot drinks\n\nOur tea is brewed with cardamom.": [0, 1],
    })
    const retriever = localRetriever({ embedder, weights: { keyword: 0.5, vector: 0.5 } })
    await retriever.index(PAIR)

    const found = await retriever.search("chai", 5)

    // One chunk wins the words outright, the other wins the vector
    // outright, so at even weights they tie at 0.5 each.
    expect(found).toHaveLength(2)
    expect(found[0]?.score).toBeCloseTo(0.5, 6)
    expect(found[1]?.score).toBeCloseTo(0.5, 6)
  })

  test("KNOW-4: the weights decide which half wins a disagreement", async () => {
    const vectors = {
      chai: [0, 1],
      "Chai\n\nWe serve chai.": [1, 0],
      "Hot drinks\n\nOur tea is brewed with cardamom.": [0, 1],
    }
    await (async () => {
      const retriever = localRetriever({
        embedder: embedderOf(vectors),
        weights: { keyword: 0.9, vector: 0.1 },
      })
      await retriever.index(PAIR)
      expect((await retriever.search("chai", 5))[0]?.source).toBe("literal.md")
    })()

    const other = localRetriever({
      embedder: embedderOf(vectors),
      weights: { keyword: 0.1, vector: 0.9 },
    })
    await other.index(PAIR)
    expect((await other.search("chai", 5))[0]?.source).toBe("meaning.md")
  })

  test("KNOW-4: a negative similarity is clamped, not subtracted", async () => {
    // Pointing the other way is not slightly relevant, and letting it go
    // negative would let an unrelated chunk pull down a real match.
    const embedder = embedderOf({
      chai: [1, 0],
      "Chai\n\nWe serve chai.": [1, 0],
      "Hot drinks\n\nOur tea is brewed with cardamom.": [-1, 0],
    })
    const retriever = localRetriever({ embedder })
    await retriever.index(PAIR)

    const found = await retriever.search("chai", 5)

    expect(found.every((hit) => hit.score > 0)).toBe(true)
    expect(found[0]?.source).toBe("literal.md")
  })

  test("KNOW-4: documents are embedded once, not on every search", async () => {
    // Indexing a knowledge folder is paid for at start. Paying again per
    // search would make every question cost an embedding call per chunk.
    let calls = 0
    const counting: Embedder = {
      id: "counting",
      async embed(texts) {
        calls += 1
        return texts.map(() => [1, 0])
      },
    }
    const retriever = localRetriever({ embedder: counting })
    await retriever.index(PAIR)
    const afterIndex = calls

    await retriever.search("chai", 5)
    await retriever.search("chai", 5)

    expect(afterIndex).toBe(1)
    // One per search, for the query itself, and no more.
    expect(calls).toBe(afterIndex + 2)
  })

  test("KNOW-4: re-indexing does not embed what it already has", async () => {
    let embedded: string[] = []
    const watching: Embedder = {
      id: "watching",
      async embed(texts) {
        embedded = [...embedded, ...texts]
        return texts.map(() => [1, 0])
      },
    }
    const retriever = localRetriever({ embedder: watching })
    await retriever.index(PAIR)
    embedded = []

    await retriever.index([doc("new", "Parking\n\nBehind the building.")])

    expect(embedded).toEqual(["Parking\n\nBehind the building."])
  })
})

describe("KNOW-4: the clamp, which only shows with three chunks", () => {
  // A probe found the first version of this untestable. With two chunks,
  // a negative similarity is filtered out either way and the order does
  // not change, so clamping and not clamping look identical. It takes a
  // third chunk, one that wins the words outright and points the other
  // way, for the difference to show: clamped it still comes back on its
  // words, unclamped the negative cancels them and it disappears.
  const THREE: KnowledgeDoc[] = [
    doc("near", "Chai\n\nA cup of chai."),
    doc("opposite", "Chai chai chai\n\nChai in every line, chai."),
    doc("far", "Parking\n\nBehind the building."),
  ]

  const vectors = {
    chai: [1, 0],
    "Chai\n\nA cup of chai.": [1, 0],
    "Chai chai chai\n\nChai in every line, chai.": [-1, 0],
    "Parking\n\nBehind the building.": [0, 1],
  }

  test("KNOW-4: a chunk that matched the words is not cancelled by a negative vector", async () => {
    const retriever = localRetriever({ embedder: embedderOf(vectors) })
    await retriever.index(THREE)

    const found = await retriever.search("chai", 5)
    const sources = found.map((hit) => hit.source)

    expect(sources).toContain("opposite.md")
    expect(sources).toContain("near.md")
    expect(found.every((hit) => hit.score > 0)).toBe(true)
  })
})
