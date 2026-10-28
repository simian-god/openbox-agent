// KNOW-1's first half: what a knowledge folder turns into before anything
// indexes it.
//
// Chunking decides what a search can find. A chunk that is too big buries
// the answer among three others; one that is too small loses the context
// that made it make sense. The Spec asks for "about 500 words on heading
// boundaries", and these tests are where that sentence becomes decisions.
import { test, expect, describe } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chunkMarkdown, loadKnowledge, CHUNK_WORDS } from "../../src/knowledge/index.ts"

const words = (n: number, word = "word"): string => Array.from({ length: n }, () => word).join(" ")

/** A knowledge folder on disk, cleaned up by the caller. */
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "openbox-knowledge-"))
  const inside = join(dir, "knowledge")
  mkdirSync(inside)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(inside, name), body)
  return dir
}

describe("KNOW-1: splitting a document into chunks", () => {
  test("KNOW-1: a heading starts a chunk, so one section is one chunk", () => {
    const docs = chunkMarkdown("## Opening hours\n\nEleven to eleven, every day.", "hours.md")

    expect(docs).toHaveLength(1)
    expect(docs[0]?.text).toContain("Eleven to eleven")
  })

  test("KNOW-1: the heading is part of the chunk's text, or nobody can search for it", () => {
    // A chunk under "Opening hours" whose body never says "hours" would
    // not match somebody asking about hours. The heading is the most
    // searchable line in the section, so it travels with it.
    const docs = chunkMarkdown("## Opening hours\n\nEleven to eleven.", "hours.md")

    expect(docs[0]?.text).toContain("Opening hours")
  })

  test("KNOW-1: two headings are two chunks, not one", () => {
    const docs = chunkMarkdown(
      "## Drinks\n\nChai and coffee.\n\n## Food\n\nDal and roti.",
      "menu.md",
    )

    expect(docs).toHaveLength(2)
    expect(docs[0]?.text).toContain("Chai")
    expect(docs[1]?.text).toContain("Dal")
    // And neither carries the other's words, which is the point of
    // splitting on headings rather than packing to a size.
    expect(docs[0]?.text).not.toContain("Dal")
  })

  test("KNOW-1: the source says which file and where in it", () => {
    const docs = chunkMarkdown("## Drinks\n\nChai.\n\n## Food\n\nDal.", "menu.md")

    expect(docs[0]?.source).toBe("menu.md#Drinks")
    expect(docs[1]?.source).toBe("menu.md#Food")
  })

  test("KNOW-1: text before the first heading is its own chunk, named for the file", () => {
    const docs = chunkMarkdown("Tiffin House, since 1994.\n\n## Drinks\n\nChai.", "about.md")

    expect(docs).toHaveLength(2)
    expect(docs[0]?.source).toBe("about.md")
    expect(docs[0]?.text).toContain("1994")
  })

  test("KNOW-1: a section over the limit is split, and every part keeps the heading", () => {
    const docs = chunkMarkdown(`## Long\n\n${words(600)}\n\n${words(600)}`, "long.md")

    expect(docs.length).toBeGreaterThan(1)
    for (const doc of docs) {
      expect(doc.text).toContain("Long")
      expect(doc.text.split(/\s+/).length).toBeLessThanOrEqual(CHUNK_WORDS * 1.5)
    }
  })

  test("KNOW-1: a long section is split between paragraphs, not mid sentence", () => {
    const first = "Alpha sentence here."
    const second = "Beta sentence here."
    const docs = chunkMarkdown(
      `## Long\n\n${first} ${words(520)}\n\n${second} ${words(520)}`,
      "long.md",
    )

    expect(docs.length).toBe(2)
    expect(docs[0]?.text).toContain(first)
    expect(docs[0]?.text).not.toContain(second)
  })

  test("KNOW-1: paragraphs are packed up to the limit, not one chunk each", () => {
    // Three paragraphs of 200 words with a 500 limit is two chunks, not
    // three: the first two fit together and the third does not. A split
    // that put every paragraph in its own chunk would pass the test
    // above and still be wrong, which is how a probe found this missing.
    const docs = chunkMarkdown(
      `## Long

${words(200, "alpha")}

${words(200, "beta")}

${words(200, "gamma")}`,
      "long.md",
    )

    expect(docs).toHaveLength(2)
    expect(docs[0]?.text).toContain("alpha")
    expect(docs[0]?.text).toContain("beta")
    expect(docs[1]?.text).toContain("gamma")
    expect(docs[1]?.text).not.toContain("beta")
  })

  test("KNOW-1: a paragraph longer than the limit on its own is still one chunk", () => {
    // Nothing is thrown away. A wall of text with no paragraph breaks is
    // somebody's knowledge file, and losing it silently would be worse
    // than one oversized chunk.
    const docs = chunkMarkdown(`## Wall\n\n${words(1200)}`, "wall.md")

    expect(docs).toHaveLength(1)
    expect(docs[0]?.text.split(/\s+/).length).toBeGreaterThan(CHUNK_WORDS)
  })

  test("KNOW-1: every chunk has an id of its own, so one can be replaced", () => {
    const docs = chunkMarkdown("## A\n\nOne.\n\n## B\n\nTwo.", "menu.md")

    expect(new Set(docs.map((doc) => doc.id)).size).toBe(2)
    // Stable, so re-reading the same file does not change what is indexed.
    const again = chunkMarkdown("## A\n\nOne.\n\n## B\n\nTwo.", "menu.md")
    expect(again.map((doc) => doc.id)).toEqual(docs.map((doc) => doc.id))
  })

  test("KNOW-1: an empty section contributes nothing", () => {
    const docs = chunkMarkdown("## Empty\n\n\n## Full\n\nSomething.", "menu.md")

    expect(docs).toHaveLength(1)
    expect(docs[0]?.source).toBe("menu.md#Full")
  })

  test("KNOW-1: a file with nothing in it is no chunks, not one empty one", () => {
    expect(chunkMarkdown("", "empty.md")).toEqual([])
    expect(chunkMarkdown("   \n\n  ", "empty.md")).toEqual([])
  })

  test("KNOW-1: deeper headings start chunks too, and say which they were", () => {
    const docs = chunkMarkdown("# Menu\n\nAll of it.\n\n### Drinks\n\nChai.", "menu.md")

    expect(docs).toHaveLength(2)
    expect(docs[0]?.source).toBe("menu.md#Menu")
    expect(docs[1]?.source).toBe("menu.md#Drinks")
  })
})

describe("KNOW-1: loading the knowledge folder", () => {
  test("KNOW-1: every file in knowledge/ is loaded", () => {
    const dir = folder({
      "menu.md": "## Drinks\n\nChai.",
      "hours.md": "## Hours\n\nEleven to eleven.",
    })
    try {
      const docs = loadKnowledge(dir)

      expect(docs.map((doc) => doc.source).sort()).toEqual(["hours.md#Hours", "menu.md#Drinks"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("KNOW-1: files are loaded in a settled order, so the index is the same twice", () => {
    const dir = folder({ "b.md": "## B\n\nTwo.", "a.md": "## A\n\nOne." })
    try {
      expect(loadKnowledge(dir).map((doc) => doc.source)).toEqual(["a.md#A", "b.md#B"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("KNOW-1: the order is the sorted one, not the order the folder gives", () => {
    // Worth a test of its own because the two differ. On this filesystem
    // `readdir` returns "_z.md" last and a sort puts it first, and on ext4
    // where CI runs `readdir` has no order at all. Two runs over the same
    // folder have to index the same things in the same order.
    const dir = folder({ "_z.md": "## Z\n\nLast.", "a.md": "## A\n\nFirst." })
    try {
      expect(loadKnowledge(dir).map((doc) => doc.source)).toEqual(["_z.md#Z", "a.md#A"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("KNOW-1: no knowledge folder is no documents, not a failure to start", () => {
    // An agent with nothing to search is a normal agent. Refusing to
    // start would make knowledge a required feature instead of a
    // optional one.
    const dir = mkdtempSync(join(tmpdir(), "openbox-knowledge-"))
    try {
      expect(loadKnowledge(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("KNOW-1: only markdown is read, so a stray file is not indexed as prose", () => {
    const dir = folder({
      "menu.md": "## Drinks\n\nChai.",
      "notes.txt": "not markdown",
      ".DS_Store": "junk",
    })
    try {
      expect(loadKnowledge(dir).map((doc) => doc.source)).toEqual(["menu.md#Drinks"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("KNOW-1: a folder inside knowledge/ is read too, with its path in the source", () => {
    const dir = mkdtempSync(join(tmpdir(), "openbox-knowledge-"))
    const inside = join(dir, "knowledge", "policies")
    mkdirSync(inside, { recursive: true })
    writeFileSync(join(inside, "refunds.md"), "## Refunds\n\nWithin seven days.")
    try {
      expect(loadKnowledge(dir).map((doc) => doc.source)).toEqual(["policies/refunds.md#Refunds"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("KNOW-1: ids are unique across files, not only within one", () => {
    // Two files can hold the same heading and the same words. If the id
    // came from the text alone, one would silently replace the other.
    const same = "## Hours\n\nEleven to eleven."
    const dir = folder({ "a.md": same, "b.md": same })
    try {
      const docs = loadKnowledge(dir)
      expect(docs).toHaveLength(2)
      expect(new Set(docs.map((doc) => doc.id)).size).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
