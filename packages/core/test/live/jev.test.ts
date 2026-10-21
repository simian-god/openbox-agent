// The one test that calls Jev for real.
//
// Everything else about this adapter is proven against recorded responses,
// which only shows it matches the documentation. This shows the
// documentation matches Jev.
//
// Only the OpenRouter route is covered. TypeSafe's own API is in early
// access behind a waitlist, so the native route is built from its docs and
// cannot be live checked here. That gap is Known K8.
//
// Skipped unless OPENBOX_LIVE=1 and OPENROUTER_API_KEY are both set, so
// the ordinary suite stays offline (TEST-3). A request this small costs a
// small fraction of a cent:
//
//   OPENBOX_LIVE=1 OPENROUTER_API_KEY=sk-... bun test packages/core/test/live
import { test, expect, describe } from "bun:test"
import { jevDecisionModel } from "../../src/providers/index.ts"
import type { Answer } from "../../src/providers/decision/types.ts"

const apiKey = process.env["OPENROUTER_API_KEY"]
const live = process.env["OPENBOX_LIVE"] === "1" && apiKey !== undefined && apiKey !== ""

describe.skipIf(!live)("DM-1: against the real Jev API, through OpenRouter", () => {
  const model = () =>
    jevDecisionModel({
      apiKey: apiKey as string,
      route: "openrouter",
      appName: "openbox-agent tests",
    })

  test("DM-1: all three question types answer in one request, with usage", async () => {
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
            payments: "a billing, charge or refund problem",
            bookings: "a question about a reservation itself",
            account: "signing in, or changing personal details",
          },
        },
        frustration: {
          type: "score",
          instructions: "How frustrated does this person sound?",
          levels: ["calm", "annoyed", "angry"],
        },
        asks_refund: {
          type: "yesno",
          instructions: "The person is asking for money back.",
        },
      },
    )

    // The answers this message obviously has. If Jev cannot get these
    // right, the adapter is pointed at the wrong thing.
    const department = answers["department"] as Extract<Answer, { type: "choice" }>
    expect(department.type).toBe("choice")
    expect(department.choice).toBe("payments")
    expect(department.probabilities["payments"]).toBeGreaterThan(0.5)
    expect(department.confidence).toBeGreaterThan(0)
    expect(department.confidence).toBeLessThanOrEqual(1)

    const frustration = answers["frustration"] as Extract<Answer, { type: "score" }>
    expect(frustration.type).toBe("score")
    expect(frustration.score).toBeGreaterThan(0)
    expect(frustration.score).toBeLessThanOrEqual(2)

    const refund = answers["asks_refund"] as Extract<Answer, { type: "yesno" }>
    expect(refund.type).toBe("yesno")
    expect(refund.p).toBeGreaterThan(0.5)

    // The docs say usage comes back with no parameter needed, and that
    // output tokens are free. This checks the first half.
    expect(usage.inputTokens).toBeGreaterThan(0)
    expect(usage.costUsd).toBeGreaterThanOrEqual(0)
  }, 60_000)

  test("DM-1: a bad key is reported as not worth retrying", async () => {
    const bad = jevDecisionModel({
      apiKey: "sk-or-v1-definitely-not-a-real-key",
      route: "openrouter",
    })

    let retryable: boolean | undefined
    try {
      await bad.ask("hello", {
        asks_refund: { type: "yesno", instructions: "The person wants a refund." },
      })
    } catch (error) {
      retryable = (error as { retryable?: boolean }).retryable
    }
    expect(retryable).toBe(false)
  }, 60_000)
})
