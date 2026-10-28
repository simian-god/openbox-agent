// DM-1: Jev, TypeSafe's decision model, over both routes it is published on.
//
// Checked against the real documentation on 2026-10-21. Both routes take
// the same `state` and `questions` body and answer with the same `answers`
// and `usage`, so one adapter serves both and only the URL, the key and the
// model id differ:
//
//   TypeSafe   POST https://api.typesafe.ai/v1/systemone      jev-1.13.0
//   OpenRouter POST https://openrouter.ai/api/alpha/decisions typesafe/jev-1.14
//
// What the vendor calls things is not what the Spec calls them, which is
// the mapping DM-1 asks each adapter for:
//
//   our yesno        is Jev's noul, and comes back as a bare probability
//   our options      is Jev's criteria, as an option map, at most 255
//   our levels       is Jev's criteria, as an ordered array of 2 to 10
//   our confidence   is Jev's own confidence, which is NOT the top
//                    probability: it describes the whole distribution
//
// The responses here are recorded in the shape the docs describe, so the
// suite stays offline (TEST-3). test/live/jev.test.ts holds the one test
// that calls the real API.
import { test, expect, describe } from "bun:test"
import { jevDecisionModel } from "../../src/providers/decision/jev.ts"
import { DecisionError, type Question } from "../../src/providers/decision/types.ts"
import type { FetchLike } from "../../src/providers/http.ts"

/** The three questions a step might ask, in the core's own shape. */
const QUESTIONS: Record<string, Question> = {
  department: {
    type: "choice",
    instructions: "Which team should handle this?",
    options: { payments: "a billing or charge problem", frontend: null, account: null },
  },
  urgency: {
    type: "score",
    instructions: "How urgent is this?",
    levels: ["can wait", "normal", "urgent"],
  },
  asks_refund: { type: "yesno", instructions: "The customer asks for a refund." },
}

/**
 * A recorded answer set, in the shape both routes' docs describe. The
 * numbers are self consistent: each spread adds to 1, and the score is the
 * spread's own expected level, as Jev's fractional score is.
 */
const ANSWERED = {
  id: "dec-abc123",
  model: "typesafe/jev-1.14-20261012",
  provider: "TypeSafe",
  answers: {
    department: {
      type: "choice",
      choice: "payments",
      confidence: 0.74,
      probabilities: { payments: 0.88, frontend: 0.09, account: 0.03 },
    },
    urgency: {
      type: "score",
      score: 1.89,
      confidence: 0.66,
      legend: { "0": "can wait", "1": "normal", "2": "urgent" },
      probabilities: { "0": 0.01, "1": 0.09, "2": 0.9 },
    },
    asks_refund: { type: "noul", noul: 0.96 },
  },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
}

/** Just enough of Jev's request body for a test to read it. */
interface WireBody {
  model?: string
  state?: unknown
  questions?: Record<string, { type?: string; instructions?: string; criteria?: unknown }>
}

/** A fetch that answers from a canned payload and records what was sent. */
function fakeFetch(payload: unknown, init: { status?: number } = {}) {
  const requests: {
    url: string
    headers: Record<string, string>
    body: WireBody
    signal: AbortSignal | null | undefined
  }[] = []

  const call: FetchLike = async (url, options) => {
    requests.push({
      url: String(url),
      headers: (options?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(options?.body ?? "{}")) as WireBody,
      signal: options?.signal ?? null,
    })
    return new Response(JSON.stringify(payload), {
      status: init.status ?? 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  return { call, requests }
}

const onOpenRouter = (payload: unknown, init: { status?: number } = {}) => {
  const { call, requests } = fakeFetch(payload, init)
  return {
    requests,
    model: jevDecisionModel({ apiKey: "sk-or-test", route: "openrouter", fetch: call }),
  }
}

const onTypeSafe = (payload: unknown, init: { status?: number } = {}) => {
  const { call, requests } = fakeFetch(payload, init)
  return {
    requests,
    model: jevDecisionModel({ apiKey: "ts-test", route: "typesafe", fetch: call }),
  }
}

describe("DM-1: the three question types map onto Jev's own", () => {
  test("DM-1: a choice sends its options as Jev's criteria, keeping a null", async () => {
    const { model, requests } = onOpenRouter(ANSWERED)
    await model.ask("a ticket", { department: QUESTIONS["department"]! })

    expect(requests[0]?.body.questions?.["department"]).toEqual({
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: { payments: "a billing or charge problem", frontend: null, account: null },
    })
  })

  test("DM-1: a score sends its levels as an ordered array, lowest first", async () => {
    const { model, requests } = onOpenRouter(ANSWERED)
    await model.ask("a ticket", { urgency: QUESTIONS["urgency"]! })

    expect(requests[0]?.body.questions?.["urgency"]).toEqual({
      type: "score",
      instructions: "How urgent is this?",
      criteria: ["can wait", "normal", "urgent"],
    })
  })

  test("DM-1: a yesno becomes a noul, and always carries both criteria", async () => {
    // OpenRouter's reference makes noul's criteria required, with both a
    // true and a false key. The Spec's whenTrue and whenFalse are
    // optional, so the adapter fills them in rather than sending a body
    // one route would reject.
    const { model, requests } = onOpenRouter(ANSWERED)
    await model.ask("a ticket", { asks_refund: QUESTIONS["asks_refund"]! })

    const sent = requests[0]?.body.questions?.["asks_refund"]
    expect(sent?.type).toBe("noul")
    const criteria = sent?.criteria as { true: string; false: string }
    expect(typeof criteria.true).toBe("string")
    expect(typeof criteria.false).toBe("string")
    expect(criteria.true.length).toBeGreaterThan(0)
    expect(criteria.false.length).toBeGreaterThan(0)
  })

  test("DM-1: whenTrue and whenFalse are used when the question gives them", async () => {
    const { model, requests } = onOpenRouter(ANSWERED)
    await model.ask("a ticket", {
      asks_refund: {
        type: "yesno",
        instructions: "The customer asks for a refund.",
        whenTrue: "they ask for money back",
        whenFalse: "they ask for anything else",
      },
    })

    expect(requests[0]?.body.questions?.["asks_refund"]?.criteria).toEqual({
      true: "they ask for money back",
      false: "they ask for anything else",
    })
  })

  test("DM-2: every question for a step goes in one request", async () => {
    const { model, requests } = onOpenRouter(ANSWERED)
    await model.ask({ subject: "refund please" }, QUESTIONS)

    expect(requests).toHaveLength(1)
    expect(Object.keys(requests[0]?.body.questions ?? {}).sort()).toEqual([
      "asks_refund",
      "department",
      "urgency",
    ])
    // The state is sent once, as given. Jev takes a string, an object or
    // an array, so the core's `unknown` passes through untouched.
    expect(requests[0]?.body.state).toEqual({ subject: "refund please" })
  })
})

describe("DM-1: the two routes", () => {
  test("DM-1: the OpenRouter route posts to the decisions endpoint with a pinned model", async () => {
    const { model, requests } = onOpenRouter(ANSWERED)
    await model.ask("a ticket", QUESTIONS)

    expect(requests[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions")
    expect(requests[0]?.headers["Authorization"]).toBe("Bearer sk-or-test")
    expect(requests[0]?.headers["Content-Type"]).toBe("application/json")
    // Pinned, not an alias: the endpoint is alpha and its shape can move.
    expect(requests[0]?.body.model).toBe("typesafe/jev-1.14")
  })

  test("DM-1: the TypeSafe route posts to its own endpoint with its own model id", async () => {
    const { model, requests } = onTypeSafe(ANSWERED)
    await model.ask("a ticket", QUESTIONS)

    expect(requests[0]?.url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(requests[0]?.headers["Authorization"]).toBe("Bearer ts-test")
    // The two routes name the same model differently.
    expect(requests[0]?.body.model).toBe("jev-1.13.0")
  })

  test("DM-1: the model id can be pinned by the caller on either route", async () => {
    const { call, requests } = fakeFetch(ANSWERED)
    const model = jevDecisionModel({
      apiKey: "sk-or-test",
      route: "openrouter",
      model: "typesafe/jev-1.13",
      fetch: call,
    })
    await model.ask("a ticket", QUESTIONS)

    expect(requests[0]?.body.model).toBe("typesafe/jev-1.13")
  })

  test("DM-1: an unknown route is refused, so a key cannot go to the wrong vendor", () => {
    // Posting a TypeSafe key to OpenRouter would hand a credential to a
    // third party, so the route is named rather than guessed.
    expect(jevDecisionModel({ apiKey: "k", route: "typesafe" }).id).toBe("jev")
    expect(() => jevDecisionModel({ apiKey: "k", route: "elsewhere" as "typesafe" })).toThrow(
      /route/,
    )
  })

  test("DM-1: OpenRouter's attribution headers are sent when they are given", async () => {
    const { call, requests } = fakeFetch(ANSWERED)
    const model = jevDecisionModel({
      apiKey: "sk-or-test",
      route: "openrouter",
      appName: "openbox-agent",
      appUrl: "https://example.test",
      fetch: call,
    })
    await model.ask("a ticket", QUESTIONS)

    expect(requests[0]?.headers["X-Title"]).toBe("openbox-agent")
    expect(requests[0]?.headers["HTTP-Referer"]).toBe("https://example.test")
  })
})

describe("DM-1: the answers come back in the Spec's shape", () => {
  test("DM-1: a noul becomes a yesno carrying the probability of yes", async () => {
    const { model } = onOpenRouter(ANSWERED)
    const { answers } = await model.ask("a ticket", QUESTIONS)

    expect(answers["asks_refund"]).toEqual({ type: "yesno", p: 0.96 })
  })

  test("DM-1: a choice keeps Jev's own confidence, not the top probability", async () => {
    // The documentation is explicit that confidence describes the whole
    // distribution and is not the largest probability. The gate thresholds
    // on it (T3.5), so taking the max instead would quietly change where
    // the line sits.
    const { model } = onOpenRouter(ANSWERED)
    const { answers } = await model.ask("a ticket", QUESTIONS)

    expect(answers["department"]).toEqual({
      type: "choice",
      choice: "payments",
      probabilities: { payments: 0.88, frontend: 0.09, account: 0.03 },
      confidence: 0.74,
    })
  })

  test("DM-1: a score keeps its fraction, because Jev's score is an expected level", async () => {
    const { model } = onOpenRouter(ANSWERED)
    const { answers } = await model.ask("a ticket", QUESTIONS)

    expect(answers["urgency"]).toEqual({
      type: "score",
      score: 1.89,
      probabilities: { "0": 0.01, "1": 0.09, "2": 0.9 },
      confidence: 0.66,
    })
  })

  test("DM-1: a confidence the vendor leaves out falls back to the spread", async () => {
    const { model } = onOpenRouter({
      ...ANSWERED,
      answers: {
        department: {
          type: "choice",
          choice: "payments",
          probabilities: { payments: 0.88, frontend: 0.09, account: 0.03 },
        },
      },
    })
    const { answers } = await model.ask("a ticket", { department: QUESTIONS["department"]! })

    expect((answers["department"] as { confidence: number }).confidence).toBeCloseTo(0.88)
  })

  test("DM-1: usage is the input tokens and the cost, since output is free", async () => {
    const { model } = onOpenRouter(ANSWERED)
    const { usage } = await model.ask("a ticket", QUESTIONS)

    expect(usage.inputTokens).toBe(476)
    expect(usage.costUsd).toBeCloseTo(0.000019992)
  })

  test("DM-1: a route that reports no cost still reports its tokens", async () => {
    const { model } = onTypeSafe({
      ...ANSWERED,
      usage: { input_tokens: 476, output_tokens: 70 },
    })
    const { usage } = await model.ask("a ticket", QUESTIONS)

    expect(usage.inputTokens).toBe(476)
    expect(usage.costUsd).toBeUndefined()
  })
})

describe("DM-1: Jev's documented limits are refused before a request is paid for", () => {
  const options = (count: number): Record<string, string | null> =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`option_${i}`, null]))

  test("DM-1: a choice over more than 255 options is refused, and points at DM-3", async () => {
    const { model, requests } = onOpenRouter(ANSWERED)

    const error = await model
      .ask("a ticket", {
        tool: { type: "choice", instructions: "Which tool?", options: options(256) },
      })
      .then(() => null)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DecisionError)
    expect((error as DecisionError).message).toMatch(/255/)
    expect((error as DecisionError).message).toMatch(/DM-3/)
    expect((error as DecisionError).retryable).toBe(false)
    expect(requests).toHaveLength(0)
  })

  test("DM-1: exactly 255 options is allowed, since that is the documented limit", async () => {
    const { model, requests } = onOpenRouter({
      ...ANSWERED,
      answers: {
        tool: {
          type: "choice",
          choice: "option_0",
          confidence: 0.5,
          probabilities: { option_0: 1 },
        },
      },
    })
    await model.ask("a ticket", {
      tool: { type: "choice", instructions: "Which tool?", options: options(255) },
    })

    expect(requests).toHaveLength(1)
  })

  test("DM-1: a score with fewer than 2 or more than 10 levels is refused", async () => {
    const { model, requests } = onOpenRouter(ANSWERED)
    const levels = (count: number) => Array.from({ length: count }, (_, i) => `level ${i}`)

    const tooFew = await model
      .ask("a ticket", { mood: { type: "score", instructions: "How?", levels: levels(1) } })
      .then(() => null)
      .catch((e: unknown) => e)
    const tooMany = await model
      .ask("a ticket", { mood: { type: "score", instructions: "How?", levels: levels(11) } })
      .then(() => null)
      .catch((e: unknown) => e)

    expect(tooFew).toBeInstanceOf(DecisionError)
    expect((tooFew as DecisionError).message).toMatch(/between 2 and 10/)
    expect(tooMany).toBeInstanceOf(DecisionError)
    expect(requests).toHaveLength(0)
  })

  test("DM-1: a step with no questions never leaves the process", async () => {
    const { model, requests } = onOpenRouter(ANSWERED)

    await expect(model.ask("a ticket", {})).rejects.toThrow(/no questions/)
    expect(requests).toHaveLength(0)
  })
})

describe("DM-1: a response that cannot be trusted is an error, not an answer", () => {
  test("DM-1: a missing answer is an error, so a gap cannot read as a low score", async () => {
    const { model } = onOpenRouter({
      ...ANSWERED,
      answers: { department: ANSWERED.answers.department },
    })

    const error = await model
      .ask("a ticket", QUESTIONS)
      .then(() => null)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DecisionError)
    expect((error as DecisionError).message).toMatch(/urgency/)
    expect((error as DecisionError).retryable).toBe(false)
  })

  test("DM-1: an answer of the wrong type for the question is an error", async () => {
    const { model } = onOpenRouter({
      ...ANSWERED,
      answers: {
        asks_refund: { type: "choice", choice: "payments", probabilities: { payments: 1 } },
      },
    })

    await expect(model.ask("a ticket", { asks_refund: QUESTIONS["asks_refund"]! })).rejects.toThrow(
      /asks_refund/,
    )
  })

  test("DM-1: probabilities that do not add up are refused, not normalised", async () => {
    // The same invariant the scripted model holds its fixtures to, so the
    // fake and the real adapter cannot disagree about what an answer is.
    const { model } = onOpenRouter({
      ...ANSWERED,
      answers: {
        department: {
          type: "choice",
          choice: "payments",
          confidence: 0.7,
          probabilities: { payments: 0.5, frontend: 0.09, account: 0.03 },
        },
      },
    })

    await expect(model.ask("a ticket", { department: QUESTIONS["department"]! })).rejects.toThrow(
      /add up/,
    )
  })

  test("DM-1: rounding is tolerated, because the vendor rounds what it sends", async () => {
    const { model } = onOpenRouter({
      ...ANSWERED,
      answers: {
        department: {
          type: "choice",
          choice: "payments",
          confidence: 0.7,
          probabilities: { payments: 0.88, frontend: 0.09, account: 0.02 },
        },
      },
    })

    const { answers } = await model.ask("a ticket", { department: QUESTIONS["department"]! })
    expect((answers["department"] as { choice: string }).choice).toBe("payments")
  })

  test("DM-1: a choice for an option that was not offered is refused", async () => {
    const { model } = onOpenRouter({
      ...ANSWERED,
      answers: {
        department: {
          type: "choice",
          choice: "legal",
          confidence: 0.9,
          probabilities: { legal: 1 },
        },
      },
    })

    await expect(model.ask("a ticket", { department: QUESTIONS["department"]! })).rejects.toThrow(
      /not one of the options/,
    )
  })

  test("DM-1: a probability outside 0 to 1 is refused", async () => {
    const { model } = onOpenRouter({
      ...ANSWERED,
      answers: { asks_refund: { type: "noul", noul: 1.4 } },
    })

    await expect(model.ask("a ticket", { asks_refund: QUESTIONS["asks_refund"]! })).rejects.toThrow(
      /between 0 and 1/,
    )
  })

  test("DM-1: a body that is not JSON at all is an error, not a crash", async () => {
    const model = jevDecisionModel({
      apiKey: "k",
      route: "openrouter",
      fetch: async () => new Response("<html>gateway</html>", { status: 200 }),
    })

    await expect(model.ask("a ticket", QUESTIONS)).rejects.toThrow(DecisionError)
  })
})

describe("GATE-4 groundwork: a failure says whether it is worth trying again", () => {
  const statuses: [number, boolean][] = [
    [400, false],
    [401, false],
    [402, false],
    [422, false],
    [429, true],
    [500, true],
    [503, true],
    [524, true],
    [529, true],
  ]

  for (const [status, retryable] of statuses) {
    test(`DM-1: HTTP ${status} is ${retryable ? "" : "not "}retryable`, async () => {
      const { model } = onOpenRouter(
        { error: { code: status, message: "upstream said no" } },
        { status },
      )

      const error = await model
        .ask("a ticket", QUESTIONS)
        .then(() => null)
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(DecisionError)
      expect((error as DecisionError).retryable).toBe(retryable)
      expect((error as DecisionError).message).toContain(String(status))
    })
  }

  test("DM-1: the message the route sends back is kept, so a key fault is readable", async () => {
    const { model } = onOpenRouter(
      { error: { code: 401, message: "No auth credentials found" } },
      { status: 401 },
    )

    await expect(model.ask("a ticket", QUESTIONS)).rejects.toThrow(/No auth credentials found/)
  })

  test("DM-1: a network failure is worth trying again", async () => {
    const model = jevDecisionModel({
      apiKey: "k",
      route: "typesafe",
      fetch: async () => {
        throw new Error("ECONNRESET")
      },
    })

    const error = await model
      .ask("a ticket", QUESTIONS)
      .then(() => null)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DecisionError)
    expect((error as DecisionError).retryable).toBe(true)
    expect((error as DecisionError).message).toMatch(/ECONNRESET/)
  })

  test("DM-1: every failure is a DecisionError, so the gate never sees a stray throw", async () => {
    const { model } = onOpenRouter({ not: "a decisions response" })

    const error = await model
      .ask("a ticket", QUESTIONS)
      .then(() => null)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DecisionError)
    expect((error as DecisionError).id).toBe("jev")
  })
})

describe("K10: a request that is given up on is cancelled", () => {
  test("K10: the signal reaches fetch, so an abandoned request can be stopped", async () => {
    // The whole of K10. Before this the request stayed in flight after the
    // step moved on, still billed and still holding a socket, because
    // `ask` had no signal to pass on.
    const { requests, model } = onOpenRouter(ANSWERED)
    const controller = new AbortController()

    await model.ask(
      "hello",
      { asks_refund: { type: "yesno", instructions: "The customer asks for a refund." } },
      { signal: controller.signal },
    )

    expect(requests[0]?.signal).toBe(controller.signal)
  })

  test("K10: no signal given means none sent, rather than a dead one", async () => {
    const { requests, model } = onOpenRouter(ANSWERED)

    await model.ask("hello", {
      asks_refund: { type: "yesno", instructions: "The customer asks for a refund." },
    })

    expect(requests[0]?.signal ?? null).toBeNull()
  })
})
