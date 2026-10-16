// Reading the source to enforce a structural rule, as DEP-1 and DATA-1
// both do. Shared so the two tests strip code the same way.
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Blanks out comments, so a rule about what the code *calls* is not
 * tripped by the same words appearing in a comment that explains the rule.
 */
export function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
}

/**
 * Blanks out comments and string literals too, for a rule that would
 * otherwise match a name mentioned inside a message or a prompt.
 */
export function code(text: string): string {
  return withoutComments(text)
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
}

/** Every .ts file under a directory, as paths relative to it. */
export function tsFiles(root: string, dir = "", found: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) tsFiles(root, rel, found)
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(rel)
  }
  return found
}

/** The source of every .ts file under a directory, with comments stripped. */
export function readCode(root: string, file: string): string {
  return code(readFileSync(join(root, file), "utf8"))
}
