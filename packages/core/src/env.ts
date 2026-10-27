// Reading an environment variable that has a default.
//
// `process.env[name] ?? fallback` reads correctly and behaves wrongly. A
// .env file that declares a variable and leaves it empty sets it to the
// empty string, which is a value, so `??` never reaches the fallback. Every
// variable in .env.example ships empty, and two of them promise in their
// own comment that empty means "fall back": DATABASE_URL says "Left empty,
// both fall back to the local stack" and OPENBOX_LIVE_MODEL says "Defaults
// to a cheap one". Copying the template as instructed broke both.
//
// The rest of the core already got this right by hand. Every provider
// checks `=== undefined || === ""` before using a key, and `openbox
// migrate` does the same with DATABASE_URL. This is that check in one
// place, for the callers that want a default rather than an error.
//
// Whitespace counts as empty and the value comes back trimmed, because a
// key pasted with a stray space or newline is a mistake and not a key, and
// an API rejecting it says far less about why than this does.

/** The environment, injectable so a test need not touch the real one. */
export type EnvSource = Record<string, string | undefined>

/**
 * A variable's value, or undefined when it is missing or blank.
 *
 * Use this anywhere a default applies. For a variable that must be set,
 * the caller still decides what to say about it, which is why this
 * reports absence rather than throwing.
 */
export function envValue(name: string, env: EnvSource = process.env): string | undefined {
  const raw = env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === "" ? undefined : trimmed
}

/** A variable's value, or `fallback` when it is missing or blank. */
export function envOr(name: string, fallback: string, env: EnvSource = process.env): string {
  return envValue(name, env) ?? fallback
}
