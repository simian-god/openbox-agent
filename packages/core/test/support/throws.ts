/**
 * Runs something expected to fail and hands back the error.
 *
 * Needed because `sql\`...\`` does not return a plain promise. It returns a
 * lazy query that runs when awaited, and `expect(query).rejects` hangs on
 * one in Bun 1.4.0 instead of failing. Awaiting inside a real async
 * function sidesteps that, and reads clearly besides.
 */
export async function failure(run: () => unknown): Promise<Error> {
  try {
    await run()
  } catch (error) {
    return error as Error
  }
  throw new Error("expected this to fail, but it succeeded")
}
