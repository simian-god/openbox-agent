// DEP-2: the OpenAI embedder, against recorded responses.
//
// Built from OpenAI's own API reference read on 2026-10-28, so these tests
// show the adapter matches the documentation. Whether the documentation
// matches the API is a different claim and this one is not checked live:
// the builder has parked OpenAI, so there is no key here. That is Known
// K28, and it is the same position the Sarvam transcriber is in.
//
// The test that matters most is the ordering one. The docs do not promise
// `data` comes back in the order the inputs went up, and every item
// carries an `index` instead. If that is ignored, every chunk gets another
// chunk's vector and the only symptom is search quietly getting worse.
import { test, expect, describe } from "bun:test"
import { openaiEmbedder, DEFAULT_EMBED_MODEL } from "../../src/providers/embedders/openai.ts"
import { EmbedError } from "../../src/providers/embedders/types.ts"
import type { FetchLike } from "../../src/providers/http.ts"

interface Call {
  url: string
  init: RequestInit
}

/** A fetch that answers from a canned payload and records what was sent. */
function serving(payload: unknown, status = 200) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }
  return {
    fetch,
    calls,
    body: () => JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>,
  }
}

/** The documented shape: data, each with an embedding and its index. */
const answered = (vectors: number[][], order?: number[]) => ({
  object: "list",
  data: vectors.map((embedding, at) => ({
    object: "embedding",
    embedding,
    index: order?.[at] ?? at,
  })),
  model: DEFAULT_EMBED_MODEL,
  usage: { prompt_tokens: 4, total_tokens: 4 },
})

describe("DEP-2: the OpenAI embedder", () => {
  test("DEP-2: one vector per text comes back", async () => {
    const { fetch } = serving(
      answered([
        [1, 2],
        [3, 4],
      ]),
    )

    const vectors = await openaiEmbedder({ apiKey: "sk-test", fetch }).embed(["one", "two"])

    expect(vectors).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  test("DEP-2: every text goes up in one request, because that is how it is billed", async () => {
    const { fetch, calls, body } = serving(answered([[1], [2], [3]]))

    await openaiEmbedder({ apiKey: "sk-test", fetch }).embed(["a", "b", "c"])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings")
    expect(body()["input"]).toEqual(["a", "b", "c"])
    expect(body()["model"]).toBe(DEFAULT_EMBED_MODEL)
    expect(body()["encoding_format"]).toBe("float")
  })

  test("DEP-2: the vectors are matched by index, not by position", async () => {
    // The documented behaviour, and the one that goes wrong silently.
    // Here the API answers in reverse: the first item carries index 1.
    const { fetch } = serving(
      answered(
        [
          [9, 9],
          [1, 1],
        ],
        [1, 0],
      ),
    )

    const vectors = await openaiEmbedder({ apiKey: "sk-test", fetch }).embed(["first", "second"])

    expect(vectors).toEqual([
      [1, 1],
      [9, 9],
    ])
  })

  test("DEP-2: a missing vector is an error, not a hole in the index", async () => {
    // Two texts, one answer. Carrying on would leave a chunk with no
    // vector and a search that silently cannot find it.
    const { fetch } = serving(answered([[1, 1]]))

    const error = (await openaiEmbedder({ apiKey: "sk-test", fetch })
      .embed(["first", "second"])
      .catch((e: unknown) => e)) as EmbedError

    expect(error).toBeInstanceOf(EmbedError)
    expect(error.message).toContain("text 1")
    expect(error.retryable).toBe(true)
  })

  test("CFG-2: the key goes in the Authorization header", async () => {
    const { fetch, calls } = serving(answered([[1]]))

    await openaiEmbedder({ apiKey: "sk-secret", fetch }).embed(["one"])

    expect((calls[0]?.init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer sk-secret",
    )
  })

  test("DEP-2: the model is pinned, and config can change it", async () => {
    const first = serving(answered([[1]]))
    await openaiEmbedder({ apiKey: "sk-test", fetch: first.fetch }).embed(["one"])
    expect(first.body()["model"]).toBe(DEFAULT_EMBED_MODEL)

    const other = serving(answered([[1]]))
    await openaiEmbedder({
      apiKey: "sk-test",
      fetch: other.fetch,
      model: "text-embedding-3-large",
    }).embed(["one"])
    expect(other.body()["model"]).toBe("text-embedding-3-large")
  })

  test("DEP-2: dimensions are sent only when asked for", async () => {
    // Documented as `text-embedding-3` and later only, so it is not sent
    // by default: an older model would refuse the whole request.
    const bare = serving(answered([[1]]))
    await openaiEmbedder({ apiKey: "sk-test", fetch: bare.fetch }).embed(["one"])
    expect(bare.body()["dimensions"]).toBeUndefined()

    const sized = serving(answered([[1]]))
    await openaiEmbedder({ apiKey: "sk-test", fetch: sized.fetch, dimensions: 256 }).embed(["one"])
    expect(sized.body()["dimensions"]).toBe(256)
  })

  test("DEP-2: an empty text is refused here, naming which one", async () => {
    // The API refuses an empty input with a 400 that names an index
    // nobody can trace back to a chunk. This says which text it was.
    const { fetch, calls } = serving(answered([[1], [2]]))

    const error = (await openaiEmbedder({ apiKey: "sk-test", fetch })
      .embed(["fine", "  "])
      .catch((e: unknown) => e)) as EmbedError

    expect(error).toBeInstanceOf(EmbedError)
    expect(error.message).toContain("text 1")
    expect(error.retryable).toBe(false)
    // And nothing was spent finding out.
    expect(calls).toEqual([])
  })

  test("DEP-2: embedding nothing costs no request", async () => {
    const { fetch, calls } = serving(answered([]))

    expect(await openaiEmbedder({ apiKey: "sk-test", fetch }).embed([])).toEqual([])
    expect(calls).toEqual([])
  })

  test("DEP-2: a 500 is worth another go, a 400 is not", async () => {
    for (const [status, retryable] of [
      [500, true],
      [429, true],
      [408, true],
      [400, false],
      [401, false],
    ] as const) {
      const { fetch } = serving({ error: { message: "nope" } }, status)
      const error = (await openaiEmbedder({ apiKey: "sk-test", fetch })
        .embed(["one"])
        .catch((e: unknown) => e)) as EmbedError
      expect(error.retryable).toBe(retryable)
    }
  })

  test("DEP-2: an answer with no data at all is an error worth retrying", async () => {
    const { fetch } = serving({ error: { message: "upstream hiccup" } })

    const error = (await openaiEmbedder({ apiKey: "sk-test", fetch })
      .embed(["one"])
      .catch((e: unknown) => e)) as EmbedError

    expect(error).toBeInstanceOf(EmbedError)
    expect(error.message).toContain("upstream hiccup")
    expect(error.retryable).toBe(true)
  })
})
