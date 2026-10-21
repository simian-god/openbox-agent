// What routing and the gate both need from a decision model call.
//
// They want opposite things from a failure. Routing fails open: an
// optimisation that cannot answer must not remove the right tool
// (ROUTE-5). The gate fails closed: a call it cannot vouch for does not
// run (GATE-4). But the way a failure is *recognised* is the same for
// both, so that part lives here and each decides for itself what to do
// with it.
import type { Answer } from "../providers/decision/types.ts"

/**
 * No usable answer, for any of the reasons there are: the request threw,
 * it ran out of time, the question is missing from the reply, or what came
 * back is not the kind of answer that was asked for.
 *
 * One type for all of them on purpose. A caller that treated a timeout
 * differently from a nonsense answer would be deciding how much to trust
 * a model it has already failed to hear from.
 */
export class NoAnswer extends Error {}

/**
 * Gives up after `ms`.
 *
 * The request itself is abandoned rather than cancelled, because the Spec's
 * `DecisionModel.ask` takes no abort signal (docs/Known.md K10). The timer
 * is always cleared, so a fast answer never holds the process open.
 */
export async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NoAnswer(`no answer within ${ms} ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The named answer, or `NoAnswer` if it is absent or the wrong kind. */
export function answerOf<K extends Answer["type"]>(
  answers: Record<string, Answer>,
  name: string,
  type: K,
): Extract<Answer, { type: K }> {
  const answer = answers[name]
  if (answer === undefined) throw new NoAnswer(`no answer for ${name}`)
  if (answer.type !== type) {
    throw new NoAnswer(`${name} was answered with a ${answer.type}, not a ${type}`)
  }
  return answer as Extract<Answer, { type: K }>
}
