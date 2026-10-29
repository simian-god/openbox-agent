// KNOW-1's first half: a knowledge folder, as documents a retriever can
// index.
//
// Chunking is the whole of this file, and it decides what a search can
// find. Too big and the answer is buried among three others that matched
// nothing; too small and the words that gave it meaning are in a different
// chunk. The Spec asks for "chunks of about 500 words on heading
// boundaries", and three decisions come out of that sentence.
//
// Headings are the boundary, and sections are never packed together to
// reach 500. A fifty word section about opening hours is a better chunk
// than those fifty words plus a hundred about parking: a keyword search
// that matched "parking" would otherwise hand the brain the hours as well,
// and KNOW-3 only returns five of these. So 500 is a ceiling, not a
// target, and a file of short FAQ headings becomes a lot of short precise
// chunks, which is the right answer for retrieval.
//
// The heading travels inside the chunk's text. A section under "Opening
// hours" whose body says "eleven to eleven" contains no searchable word
// for the question "what are your hours", and the heading is usually the
// most searchable line in the section.
//
// And nothing is ever dropped to keep the size. A single paragraph longer
// than the limit stays one oversized chunk, because somebody wrote it and
// silently losing it is worse than one chunk that is too long.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, posix } from "node:path"

/** KNOW-1: the folder inside an agent project that holds its documents. */
export const KNOWLEDGE_DIR = "knowledge"

/** KNOW-1: "about 500 words". A ceiling for one chunk, not a target. */
export const CHUNK_WORDS = 500

/** What a retriever indexes, and what `search_knowledge` returns from. */
export interface KnowledgeDoc {
  /**
   * Stable across reloads, and unique across files.
   *
   * From the source and the text together: two files may hold the same
   * heading and the same words, and an id from the text alone would let
   * one silently replace the other in the index.
   */
  id: string
  /** The chunk itself, heading included. */
  text: string
  /** KNOW-3: the file, and where in the file. `menu.md#Drinks`. */
  source: string
}

/** One section of a document: its heading, if it had one, and its body. */
interface Section {
  heading: string | undefined
  body: string
}

const ATX_HEADING = /^(#{1,6})\s+(.*)$/

/**
 * Splits a document on its headings.
 *
 * Only ATX headings, the `#` kind. Setext underlining is valid markdown
 * and is not handled, which is a deliberate limit rather than an
 * oversight: a knowledge file that uses it gets one large chunk per
 * document instead of one per section, which is worse retrieval but never
 * wrong, and nothing is lost.
 */
function sectionsOf(text: string): Section[] {
  const sections: Section[] = []
  let heading: string | undefined
  let body: string[] = []

  const flush = (): void => {
    const joined = body.join("\n").trim()
    if (joined !== "" || heading !== undefined) sections.push({ heading, body: joined })
    body = []
  }

  for (const line of text.split(/\r?\n/)) {
    const match = ATX_HEADING.exec(line)
    if (match === null) {
      body.push(line)
      continue
    }
    flush()
    heading = (match[2] ?? "").trim()
  }
  flush()
  return sections
}

/** Words, for the only measure KNOW-1 gives. */
const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length

/**
 * Splits one section's body into pieces no longer than the limit.
 *
 * On blank lines, so a chunk never ends mid sentence when it can avoid
 * it. A single paragraph over the limit is returned whole: see the note at
 * the top about never dropping anything.
 */
function piecesOf(body: string, limit: number): string[] {
  if (countWords(body) <= limit) return body.trim() === "" ? [] : [body.trim()]

  const paragraphs = body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== "")

  const pieces: string[] = []
  let current: string[] = []
  let words = 0

  for (const paragraph of paragraphs) {
    const size = countWords(paragraph)
    // Adding this one would go over, and there is something to close off.
    if (words > 0 && words + size > limit) {
      pieces.push(current.join("\n\n"))
      current = []
      words = 0
    }
    current.push(paragraph)
    words += size
  }
  if (current.length > 0) pieces.push(current.join("\n\n"))
  return pieces
}

/**
 * KNOW-1: one document's text, as chunks.
 *
 * `source` is the file's path inside the knowledge folder, which becomes
 * the chunk's source with the heading appended.
 */
export function chunkMarkdown(text: string, source: string, limit = CHUNK_WORDS): KnowledgeDoc[] {
  const docs: KnowledgeDoc[] = []

  for (const section of sectionsOf(text)) {
    const where = section.heading === undefined ? source : `${source}#${section.heading}`
    for (const piece of piecesOf(section.body, limit)) {
      // The heading is part of the text, and part of every piece of a
      // section that had to be split.
      const body = section.heading === undefined ? piece : `${section.heading}\n\n${piece}`
      docs.push({ id: idOf(where, body), text: body, source: where })
    }
  }
  return docs
}

/** Stable, and unique across files: the source is in the hash too. */
function idOf(source: string, text: string): string {
  return createHash("sha256").update(`${source}\u0000${text}`).digest("hex").slice(0, 32)
}

/** Every markdown file under a folder, as paths relative to it. */
function markdownIn(root: string, dir = "", found: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    // Posix separators, so a source reads the same on every machine.
    const rel = dir === "" ? entry.name : posix.join(dir, entry.name)
    if (entry.isDirectory()) {
      markdownIn(root, rel, found)
      continue
    }
    if (entry.name.toLowerCase().endsWith(".md")) found.push(rel)
  }
  return found
}

export interface LoadKnowledgeOptions {
  /** The folder inside the project. `knowledge` by default. */
  folder?: string | undefined
  /** Words per chunk. `CHUNK_WORDS` by default. */
  limit?: number | undefined
}

/**
 * KNOW-1: every document in an agent project's knowledge folder.
 *
 * No folder means no documents rather than a failure: an agent with
 * nothing to search is an ordinary agent, and refusing to start would make
 * knowledge a requirement instead of a feature.
 *
 * Sorted, so two runs over the same folder index the same things in the
 * same order. `readdir` does not promise that on its own.
 */
export function loadKnowledge(dir: string, options: LoadKnowledgeOptions = {}): KnowledgeDoc[] {
  const root = join(dir, options.folder ?? KNOWLEDGE_DIR)
  if (!existsSync(root) || !statSync(root).isDirectory()) return []

  return markdownIn(root)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((file) => chunkMarkdown(readFileSync(join(root, file), "utf8"), file, options.limit))
}

/**
 * KNOW-1 and LEARN-6: an approved knowledge entry, as a document.
 *
 * The question and the answer both go in the text, because somebody
 * searching usually phrases it like the question rather than like the
 * answer, and the answer is what they need back.
 *
 * The source names the entry rather than describing it. KNOW-3 hands this
 * to the brain as where the answer came from, and `entry:3f2a` can be
 * found again in the table while "an operator said so" cannot.
 */
export function entryDoc(entry: { id: string; question: string; answer: string }): KnowledgeDoc {
  const text = `${entry.question.trim()}

${entry.answer.trim()}`
  return { id: `entry:${entry.id}`, text, source: `entry:${entry.id}` }
}
