// LEARN-1's frustration question.
//
// Nine of LEARN-1's ten flags are raised by something that already
// happened: a handover opened, a tool failed, the gate said Block. This
// one is the exception. Nothing in a turn tells the core how the person
// sounds, so it has to be asked, and asking costs money.
//
// So it rides along with HAND-1's `wants_human` in the first step's
// decision request (section 7, LOOP-8 step 1), which DM-2 is for: both
// questions are about the same conversation, and sending them together
// pays for that state once. An agent on one tool asks nothing else there,
// and the request goes out with these two questions alone.
//
// It is a `score`, not a yes or no, because the Spec's threshold is 1.5 on
// a 0 to 2 scale and 1.5 is not a point on a yes or no answer. Every route
// returns a score as the spread's expected level, so 1.5 means something
// real: more annoyed than annoyed, not yet angry. A hard pick of one of
// three words could only ever answer 0, 1 or 2, and the Spec's own default
// would then be an odd way of writing "angry".
//
// What this is not. It does not open a handover. HAND-1's question does
// that, and it rides in the same request: one asks how they feel and the
// other asks what they want, and a person can be angry and still want the
// agent to finish the job. Flagging feeling and handing over on want is
// the difference between a digest a builder reads on Monday and an
// operator woken up every time somebody is cross.
import type { Answer, Question } from "../providers/decision/types.ts"

/** The question's name in the request, since DM-2 sends several at once. */
export const FRUSTRATION = "frustration"

/**
 * The scale, lowest first. The index is the score, so the order is the
 * scale: `calm` is 0 and `angry` is 2, which is what the Spec's 0 to 2
 * means and what a threshold of 1.5 is measured against.
 */
export const FRUSTRATION_LEVELS = ["calm", "annoyed", "angry"] as const

/** LEARN-1: how this person sounds, on the Spec's own three point scale. */
export function frustrationQuestion(): Extract<Question, { type: "score" }> {
  return {
    type: "score",
    instructions:
      "How does this person sound in their latest messages? Judge their tone, not whether the agent is doing well.",
    levels: [...FRUSTRATION_LEVELS],
  }
}

/**
 * LEARN-1: at or above the threshold, which is a config line.
 *
 * "At or above" is the Spec's wording and is why this is `>=`: a score
 * that lands exactly on the threshold is flagged.
 *
 * An answer of the wrong shape is not frustration rather than an error.
 * This runs on the first step of every turn, the adapters already validate
 * what they return, and a decision model is somebody else's code: a turn
 * that answered the person is not worth losing over a malformed mood.
 */
export function isFrustrated(answer: Answer | undefined, threshold: number): boolean {
  return answer !== undefined && answer.type === "score" && answer.score >= threshold
}
