// DM-1: the OpenAI Decisions API.
//
// Spec section 23 listed this one as "in beta, and only secondary sources
// were read". Checked against OpenAI's own documentation on 2026-10-21, and
// it is a different wire shape from Jev in almost every respect:
//
//   POST https://api.openai.com/v1/decisions   model gpt-6-luna
//
//   questions are an ARRAY, each carrying its own name, not a map
//   a choice offers  choices: [{ value, description }]
//   a score offers   levels:  [{ label, description }], lowest first
//   a predicate takes no criteria at all, so the Spec's whenTrue and
//     whenFalse have nowhere to go but the instructions
//   answers are an ARRAY, matched back by name
//   probabilities are ARRAYS of objects, not a map
//   input takes text, so a state that is not a string has to be written out
//   a question can come back REFUSED, which no other route has
//
// The responses here are recorded in the shape those docs describe, so the
// suite stays offline (TEST-3). test/live holds the one test that calls the
// real API.
import { test, expect, describe } from "bun:test"
import { openaiDecisionsModel } from "../../src/providers/decision/openai-decisions.ts"
import { DecisionError, type Question } from "../../src/providers/decision/types.ts"
import type { FetchLike } from "../../src/providers/http.ts"

const QUESTIONS: Record<string, Question> = {
  department: {
    type: "choice",
    instructions: "Which team should handle this?",
    options: { billing: "a charge or refund problem", bookings: null },
  },
  severity: {
    type: "score",
    instructions: "How severe is this?",
    levels: ["cosmetic", "annoying", "blocking"],
  },
  wants_human: { type: "yesno", instructions: "The person wants to talk to a person." },
}

/** A recorded answer set, in the shape OpenAI's docs describe. */
const ANSWERED = {
  answers: [
    {
      type: "choice",
      name: "department",
      choice: "billing",
      probabilities: [
        { value: "billing", probability: 0.91 },
        { value: "bookings", probability: 0.09 },
      ],
      confidence: 0.77,
    },
    {
      type: "score",
      name: "severity",
      score: 1.1,
      probabilities: [
        { value: 0, label: "cosmetic", probability: 0.1 },
        { value: 1, label: "annoying", probability: 0.7 },
        { value: 2, label: "blocking", probability: 0.2 },
      ],
      confidence: 0.55,
    },
    { type: "predicate", name: "wants_human", probability: 0.12 },
  ],
}

/** Just enough of the request body for a test to read it. */
interface WireBody {
  model?: string
  input?: unknown
  questions?: {
    type?: string
    name?: string
    instructions?: string
    choices?: { value: string; description?: string }[]
    levels?: { label: string; description?: string }[]
  }[]
}

function fakeFetch(payload: unknown, init: { status?: number } = {}) {
  const requests: { url: string; headers: Record<string, string>; body: WireBody }[] = []

  const call: FetchLike = async (url, options) => {
    requests.push({
      url: String(url),
      headers: (options?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(options?.body ?? "{}")) as WireBody,
    })
    return new Response(JSON.stringify(payload), {
      status: init.status ?? 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  return { call, requests }
}

const built = (payload: unknown, init: { status?: number } = {}) => {
  const { call, requests } = fakeFetch(payload, init)
  return { requests, model: openaiDecisionsModel({ apiKey: "sk-test", fetch: call }) }
}

describe("DM-1: the request is in OpenAI's own shape", () => {
  test("DM-1: it posts to the decisions endpoint with the only model there is", async () => {
    const { model, requests } = built(ANSWERED)
    await model.ask("a ticket", QUESTIONS)

    expect(requests[0]?.url).toBe("https://api.openai.com/v1/decisions")
    expect(requests[0]?.headers["Authorization"]).toBe("Bearer sk-test")
    expect(requests[0]?.body.model).toBe("gpt-6-luna")
  })

  test("DM-1: the model can be pinned by the caller", async () => {
    const { call, requests } = fakeFetch(ANSWERED)
    const model = openaiDecisionsModel({
      apiKey: "sk-test",
      model: "gpt-6-luna-2026-10-06",
      fetch: call,
    })
    await model.ask("a ticket", QUESTIONS)

    expect(requests[0]?.body.model).toBe("gpt-6-luna-2026-10-06")
  })

  test("DM-2: every question for a step goes in one request, as an array of named questions", async () => {
    const { model, requests } = built(ANSWERED)
    await model.ask("a ticket", QUESTIONS)

    expect(requests).toHaveLength(1)
    // The core holds questions in a map; this API wants a list, with the
    // name moved inside each one.
    expect(requests[0]?.body.questions?.map((q) => q.name)).toEqual([
      "department",
      "severity",
      "wants_human",
    ])
  })

  test("DM-1: a choice offers its options as value and description objects", async () => {
    const { model, requests } = built(ANSWERED)
    await model.ask("a ticket", { department: QUESTIONS["department"]! })

    expect(requests[0]?.body.questions?.[0]).toEqual({
      type: "choice",
      name: "department",
      instructions: "Which team should handle this?",
      // A null description is left out rather than sent as null: the
      // option's own name is the explanation in that case.
      choices: [
        { value: "billing", description: "a charge or refund problem" },
        { value: "bookings" },
      ],
    })
  })

  test("DM-1: a score offers its levels as labels, lowest first", async () => {
    const { model, requests } = built(ANSWERED)
    await model.ask("a ticket", { severity: QUESTIONS["severity"]! })

    expect(requests[0]?.body.questions?.[0]).toEqual({
      type: "score",
      name: "severity",
      instructions: "How severe is this?",
      levels: [{ label: "cosmetic" }, { label: "annoying" }, { label: "blocking" }],
    })
  })

  test("DM-1: a yesno becomes a predicate, which takes no criteria", async () => {
    const { model, requests } = built(ANSWERED)
    await model.ask("a ticket", { wants_human: QUESTIONS["wants_human"]! })

    expect(requests[0]?.body.questions?.[0]).toEqual({
      type: "predicate",
      name: "wants_human",
      instructions: "The person wants to talk to a person.",
    })
  })

  test("DM-1: whenTrue and whenFalse are folded into the instructions, not dropped", async () => {
    // A predicate has nowhere to put them, and throwing away guidance the
    // builder wrote would quietly make this route worse than Jev at the
    // same question.
    const { model, requests } = built(ANSWERED)
    await model.ask("a ticket", {
      wants_human: {
        type: "yesno",
        instructions: "The person wants to talk to a person.",
        whenTrue: "they ask for a human, a manager or a colleague",
        whenFalse: "they are still happy to be helped here",
      },
    })

    const instructions = requests[0]?.body.questions?.[0]?.instructions ?? ""
    expect(instructions).toContain("The person wants to talk to a person.")
    expect(instructions).toContain("they ask for a human, a manager or a colleague")
    expect(instructions).toContain("they are still happy to be helped here")
  })

  test("DM-1: a string state is the input as it stands", async () => {
    const { model, requests } = built(ANSWERED)
    await model.ask("just these words", { wants_human: QUESTIONS["wants_human"]! })

    expect(requests[0]?.body.input).toBe("just these words")
  })

  test("DM-1: a state that is not a string is written out, because input takes text", async () => {
    // Jev accepts an object here and this API does not, which is exactly
    // the kind of difference an adapter exists to absorb.
    const { model, requests } = built(ANSWERED)
    await model.ask({ person: "p1", said: "hello" }, { wants_human: QUESTIONS["wants_human"]! })

    expect(requests[0]?.body.input).toBe('{"person":"p1","said":"hello"}')
  })
})

describe("DM-1: the answers come back in the Spec's shape", () => {
  test("DM-1: a predicate becomes a yesno carrying the probability", async () => {
    const { model } = built(ANSWERED)
    const { answers } = await model.ask("a ticket", QUESTIONS)

    expect(answers["wants_human"]).toEqual({ type: "yesno", p: 0.12 })
  })

  test("DM-1: a choice turns its probability list into a spread, keeping the confidence", async () => {
    const { model } = built(ANSWERED)
    const { answers } = await model.ask("a ticket", QUESTIONS)

    expect(answers["department"]).toEqual({
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.91, bookings: 0.09 },
      confidence: 0.77,
    })
  })

  test("DM-1: a score keys its spread by the level index, as the other route does", async () => {
    // Jev sends "0", "1", "2" and this API sends 0, 1, 2 inside objects.
    // Both become the same spread, so nothing downstream has to know which
    // provider answered.
    const { model } = built(ANSWERED)
    const { answers } = await model.ask("a ticket", QUESTIONS)

    expect(answers["severity"]).toEqual({
      type: "score",
      score: 1.1,
      probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
      confidence: 0.55,
    })
  })

  test("DM-1: answers are matched by name, not by the order they arrive in", async () => {
    const shuffled = { answers: [...ANSWERED.answers].reverse() }
    const { model } = built(shuffled)
    const { answers } = await model.ask("a ticket", QUESTIONS)

    expect((answers["department"] as { choice: string }).choice).toBe("billing")
    expect((answers["wants_human"] as { p: number }).p).toBe(0.12)
  })
})

describe("DM-1: a refusal is not an answer", () => {
  test("DM-1: a refused question is a DecisionError naming it", async () => {
    // This route can decline a question outright, which no other one does.
    // A refusal must never read as a low probability: GATE-4 fails closed,
    // and a 0 would look like a confident no.
    const { model } = built({
      answers: [{ type: "refusal", name: "wants_human" }],
    })

    const error = await model
      .ask("a ticket", { wants_human: QUESTIONS["wants_human"]! })
      .then(() => null)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DecisionError)
    expect((error as DecisionError).message).toMatch(/refused/)
    expect((error as DecisionError).message).toMatch(/wants_human/)
    // The same input would be refused again, so there is nothing to retry.
    expect((error as DecisionError).retryable).toBe(false)
  })

  test("DM-1: one refusal in a set of three fails the whole step", async () => {
    const { model } = built({
      answers: [ANSWERED.answers[0]!, { type: "refusal", name: "severity" }, ANSWERED.answers[2]!],
    })

    await expect(model.ask("a ticket", QUESTIONS)).rejects.toThrow(/severity/)
  })
})

describe("DM-1: a response that cannot be trusted is an error", () => {
  test("DM-1: a missing answer is an error, so a gap cannot read as a low score", async () => {
    const { model } = built({ answers: [ANSWERED.answers[0]!] })

    const error = await model
      .ask("a ticket", QUESTIONS)
      .then(() => null)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DecisionError)
    expect((error as DecisionError).message).toMatch(/severity/)
  })

  test("DM-1: an answer of the wrong type for the question is an error", async () => {
    const { model } = built({
      answers: [{ type: "predicate", name: "department", probability: 0.5 }],
    })

    await expect(model.ask("a ticket", { department: QUESTIONS["department"]! })).rejects.toThrow(
      /department/,
    )
  })

  test("DM-1: probabilities that do not add up are refused, not normalised", async () => {
    const { model } = built({
      answers: [
        {
          type: "choice",
          name: "department",
          choice: "billing",
          probabilities: [
            { value: "billing", probability: 0.5 },
            { value: "bookings", probability: 0.09 },
          ],
          confidence: 0.7,
        },
      ],
    })

    await expect(model.ask("a ticket", { department: QUESTIONS["department"]! })).rejects.toThrow(
      /add up/,
    )
  })

  test("DM-1: a choice for an option that was not offered is refused", async () => {
    const { model } = built({
      answers: [
        {
          type: "choice",
          name: "department",
          choice: "legal",
          probabilities: [{ value: "legal", probability: 1 }],
          confidence: 0.9,
        },
      ],
    })

    await expect(model.ask("a ticket", { department: QUESTIONS["department"]! })).rejects.toThrow(
      /not one of the options/,
    )
  })

  test("DM-1: a probability outside 0 to 1 is refused", async () => {
    const { model } = built({
      answers: [{ type: "predicate", name: "wants_human", probability: 1.4 }],
    })

    await expect(model.ask("a ticket", { wants_human: QUESTIONS["wants_human"]! })).rejects.toThrow(
      /between 0 and 1/,
    )
  })

  test("DM-1: the same option twice in one spread is refused", async () => {
    const { model } = built({
      answers: [
        {
          type: "choice",
          name: "department",
          choice: "billing",
          probabilities: [
            { value: "billing", probability: 0.5 },
            { value: "billing", probability: 0.5 },
          ],
          confidence: 0.7,
        },
      ],
    })

    await expect(model.ask("a ticket", { department: QUESTIONS["department"]! })).rejects.toThrow(
      /came back twice/,
    )
  })

  test("DM-1: a probability entry with no value is refused", async () => {
    const { model } = built({
      answers: [
        {
          type: "choice",
          name: "department",
          choice: "billing",
          probabilities: [{ probability: 1 }],
          confidence: 0.7,
        },
      ],
    })

    await expect(model.ask("a ticket", { department: QUESTIONS["department"]! })).rejects.toThrow(
      DecisionError,
    )
  })

  test("DM-1: a step with no questions never leaves the process", async () => {
    const { model, requests } = built(ANSWERED)

    await expect(model.ask("a ticket", {})).rejects.toThrow(/no questions/)
    expect(requests).toHaveLength(0)
  })
})

describe("DM-1: usage, which these docs do not describe", () => {
  test("DM-1: a usage object is read when one is sent", async () => {
    const { model } = built({
      ...ANSWERED,
      usage: { input_tokens: 412, output_tokens: 0, total_tokens: 412 },
    })
    const { usage } = await model.ask("a ticket", QUESTIONS)

    expect(usage.inputTokens).toBe(412)
  })

  test("DM-1: no usage object means no tokens reported, and never a crash", async () => {
    // The Decisions guide documents no usage object. Billing is per input
    // token, so one probably exists, but nothing here may depend on it.
    const { model } = built(ANSWERED)
    const { usage } = await model.ask("a ticket", QUESTIONS)

    expect(usage.inputTokens).toBe(0)
    expect(usage.costUsd).toBeUndefined()
  })
})

describe("GATE-4 groundwork: a failure says whether it is worth trying again", () => {
  const errorBody = (type: string, code?: string) => ({
    error: { message: "the route said no", type, ...(code !== undefined ? { code } : {}) },
  })

  test("DM-1: a rate limit is worth trying again", async () => {
    const { model } = built(errorBody("rate_limit_error", "slow_down"), { status: 429 })

    const error = await model
      .ask("a ticket", QUESTIONS)
      .then(() => null)
      .catch((e: unknown) => e)

    expect((error as DecisionError).retryable).toBe(true)
  })

  test("DM-1: a 429 because the credit is gone is NOT worth trying again", async () => {
    // Both arrive as 429 and only the body tells them apart. Retrying this
    // one burns the backoff for nothing: no amount of waiting adds credit.
    for (const code of [
      "credit_balance_exhausted",
      "insufficient_quota",
      "billing_hard_limit_reached",
    ]) {
      const { model } = built(errorBody("invalid_request_error", code), { status: 429 })

      const error = await model
        .ask("a ticket", QUESTIONS)
        .then(() => null)
        .catch((e: unknown) => e)

      expect((error as DecisionError).retryable).toBe(false)
      expect((error as DecisionError).message).toContain(code)
    }
  })

  test("DM-1: a bad key is not worth trying again, and its message is kept", async () => {
    const { model } = built(
      { error: { message: "Incorrect API key provided", type: "invalid_request_error" } },
      { status: 401 },
    )

    const error = await model
      .ask("a ticket", QUESTIONS)
      .then(() => null)
      .catch((e: unknown) => e)

    expect((error as DecisionError).retryable).toBe(false)
    expect((error as DecisionError).message).toContain("Incorrect API key provided")
    expect((error as DecisionError).message).toContain("401")
  })

  test("DM-1: an overloaded model is worth trying again", async () => {
    const { model } = built(errorBody("service_unavailable_error", "server_is_overloaded"), {
      status: 503,
    })

    const error = await model
      .ask("a ticket", QUESTIONS)
      .then(() => null)
      .catch((e: unknown) => e)

    expect((error as DecisionError).retryable).toBe(true)
  })

  test("DM-1: a network failure is worth trying again", async () => {
    const model = openaiDecisionsModel({
      apiKey: "sk-test",
      fetch: async () => {
        throw new Error("ETIMEDOUT")
      },
    })

    const error = await model
      .ask("a ticket", QUESTIONS)
      .then(() => null)
      .catch((e: unknown) => e)

    expect((error as DecisionError).retryable).toBe(true)
    expect((error as DecisionError).message).toMatch(/ETIMEDOUT/)
  })

  test("DM-1: every failure is a DecisionError under this id", async () => {
    const { model } = built({ nothing: "useful" })

    const error = await model
      .ask("a ticket", QUESTIONS)
      .then(() => null)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DecisionError)
    expect((error as DecisionError).id).toBe("openai-decisions")
  })

  test("DM-1: a body that is not JSON at all is an error, not a crash", async () => {
    const model = openaiDecisionsModel({
      apiKey: "sk-test",
      fetch: async () => new Response("<html>gateway</html>", { status: 502 }),
    })

    const error = await model
      .ask("a ticket", QUESTIONS)
      .then(() => null)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DecisionError)
    expect((error as DecisionError).retryable).toBe(true)
  })
})

test("C3: both decision models answer the same questions the same way", async () => {
  // C3 in the Plan is "same tests on both decision models". The point of
  // the interface is that the core cannot tell which one answered, so the
  // two adapters are given the same step over their own wire shapes and
  // their answers are compared.
  const { jevDecisionModel } = await import("../../src/providers/decision/jev.ts")

  const jevFetch = fakeFetch({
    answers: {
      department: {
        type: "choice",
        choice: "billing",
        confidence: 0.77,
        probabilities: { billing: 0.91, bookings: 0.09 },
      },
      severity: {
        type: "score",
        score: 1.1,
        confidence: 0.55,
        probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
      },
      wants_human: { type: "noul", noul: 0.12 },
    },
    usage: { input_tokens: 412, output_tokens: 0 },
  })
  const openaiFetch = fakeFetch({
    ...ANSWERED,
    usage: { input_tokens: 412, output_tokens: 0, total_tokens: 412 },
  })

  const viaJev = await jevDecisionModel({
    apiKey: "k",
    route: "openrouter",
    fetch: jevFetch.call,
  }).ask("a ticket", QUESTIONS)
  const viaOpenai = await openaiDecisionsModel({
    apiKey: "k",
    fetch: openaiFetch.call,
  }).ask("a ticket", QUESTIONS)

  expect(viaOpenai.answers).toEqual(viaJev.answers)
  expect(viaOpenai.usage.inputTokens).toBe(viaJev.usage.inputTokens)
})
