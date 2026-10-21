// The one test that calls the OpenAI Decisions API for real.
//
// Everything else about this adapter is proven against recorded responses,
// which only shows it matches the documentation. This shows the
// documentation matches the API, which matters more here than anywhere
// else: the endpoint is in beta, and the docs describe no usage object and
// no limits (docs/Known.md K9).
//
// Skipped unless OPENBOX_LIVE=1 and OPENAI_API_KEY are both set, so the
// ordinary suite stays offline (TEST-3). Input is $0.10 per million tokens
// and output is free, so this costs a small fraction of a cent:
//
//   OPENBOX_LIVE=1 OPENAI_API_KEY=sk-... bun test packages/core/test/live
import { test, expect, describe } from "bun:test"
import { openaiDecisionsModel } from "../../src/providers/index.ts"
import type { Answer } from "../../src/providers/decision/types.ts"

const apiKey = process.env["OPENAI_API_KEY"]
const live = process.env["OPENBOX_LIVE"] === "1" && apiKey !== undefined && apiKey !== ""

describe.skipIf(!live)("DM-1: against the real OpenAI Decisions API", () => {
  const model = () => openaiDecisionsModel({ apiKey: apiKey as string })

  test("DM-1: all three question types answer in one request", async () => {
    const { answers, usage } = await model().ask(
      {
        channel: "whatsapp",
        message: "My card was charged twice for the same booking. I want my money back.",
      },
      {
        department: {
          type: "choice",
          instructions: "Which team should handle this message?",
          options: {
            billing: "a billing, charge or refund problem",
            bookings: "a question about a reservation itself",
            other: "anything else",
          },
        },
        severity: {
          type: "score",
          instructions: "How badly is this person affected?",
          levels: ["barely", "inconvenienced", "out of pocket"],
        },
        asks_refund: {
          type: "yesno",
          instructions: "The person is asking for money back.",
          whenTrue: "they ask for a refund, a reversal or their money back",
          whenFalse: "they ask for anything else",
        },
      },
    )

    const department = answers["department"] as Extract<Answer, { type: "choice" }>
    expect(department.choice).toBe("billing")
    expect(department.probabilities["billing"]).toBeGreaterThan(0.5)
    expect(department.confidence).toBeGreaterThan(0)

    const severity = answers["severity"] as Extract<Answer, { type: "score" }>
    expect(severity.score).toBeGreaterThan(0)
    expect(severity.score).toBeLessThanOrEqual(2)

    const refund = answers["asks_refund"] as Extract<Answer, { type: "yesno" }>
    expect(refund.p).toBeGreaterThan(0.5)

    // Whether a usage object comes back at all is the open question in K9.
    // This records the answer rather than asserting one.
    console.log(`[live] OpenAI Decisions reported inputTokens=${usage.inputTokens}`)
  }, 60_000)

  test("DM-1: a bad key is reported as not worth retrying", async () => {
    const bad = openaiDecisionsModel({ apiKey: "sk-definitely-not-a-real-key" })

    let retryable: boolean | undefined
    try {
      await bad.ask("hello", {
        wants_human: { type: "yesno", instructions: "The person wants a human." },
      })
    } catch (error) {
      retryable = (error as { retryable?: boolean }).retryable
    }
    expect(retryable).toBe(false)
  }, 60_000)
})
