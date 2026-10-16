// CFG-2: secrets never go in config. Providers read keys from the
// environment. A key put in config would otherwise be committed, since
// config is an ordinary source file.

/**
 * Field names that mean "this is a credential". Matched against the last
 * word of a field name, so `apiKey` and `auth_token` are caught while
 * `keyholder` and `tokenCount` are left alone.
 */
const SECRET_WORDS = new Set([
  "key",
  "apikey",
  "secret",
  "token",
  "password",
  "passwd",
  "credential",
  "credentials",
  "auth",
])

/** Splits camelCase, snake_case and kebab-case into lowercase words. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase())
}

function looksLikeASecret(name: string): boolean {
  const parts = words(name)
  const last = parts[parts.length - 1]
  return last !== undefined && SECRET_WORDS.has(last)
}

/**
 * Every path in the config that names a credential. The value is never
 * included: this message may be printed, logged or pasted into a chat.
 */
export function findSecrets(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findSecrets(item, [...path, String(i)]))
  }
  if (value === null || typeof value !== "object") return []

  const found: string[] = []
  for (const [name, child] of Object.entries(value)) {
    const here = [...path, name]
    // A credential is a value, not a container. `auth: { token: "..." }`
    // is walked into so the report names the token itself.
    const isContainer = child !== null && typeof child === "object"
    if (!isContainer && looksLikeASecret(name)) found.push(here.join("."))
    else found.push(...findSecrets(child, here))
  }
  return found
}
