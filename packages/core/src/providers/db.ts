// DEP-1: the database client is built here, with the brains, because this
// is the one folder allowed to reach the outside world. Everything else
// takes the client already built.
//
// CFG-2 is why the URL and the key come from the environment and not from
// config: a service role key in a config file would be committed.
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { ProviderError, type Env } from "./index.ts"
import { envValue } from "../env.ts"

/** Also the list in .env.example. */
export const DB_ENV_KEYS = {
  url: "SUPABASE_URL",
  serviceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
} as const

/**
 * The client an agent runs with: the service role key, which bypasses RLS.
 * The anon key that ships in a frontend reaches none of the core's tables
 * (DATA-5), so it cannot be used here.
 */
export function supabaseFromEnv(env: Env = process.env): SupabaseClient {
  const url = envValue(DB_ENV_KEYS.url, env)
  const key = envValue(DB_ENV_KEYS.serviceRoleKey, env)

  const problems: string[] = []
  if (url === undefined) {
    problems.push(`the database needs ${DB_ENV_KEYS.url} in the environment`)
  }
  if (key === undefined) {
    problems.push(
      `the database needs ${DB_ENV_KEYS.serviceRoleKey} in the environment. Secrets never go in config (CFG-2)`,
    )
  }
  if (problems.length > 0) throw new ProviderError(problems)

  return createClient(url as string, key as string, { auth: { persistSession: false } })
}
