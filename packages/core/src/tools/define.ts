// TOOL-1 to TOOL-3: defining an agent tool, the rules registration
// enforces, and the description the brain reads.
import { z } from "zod"
import { isBuiltinToolName } from "./builtins.ts"
import type { TimeHelpers } from "../time/index.ts"

/** How much damage a call can do. Decides whether the gate runs (LOOP-8). */
export type Risk = "read" | "write" | "irreversible"
export const RISK_LEVELS: readonly Risk[] = ["read", "write", "irreversible"]

/** ROLE-1: a person is one of these. Nothing in a message can change it. */
export type Role = "end_user" | "operator"
export const ROLES: readonly Role[] = ["end_user", "operator"]

/** A brain can only call a name shaped like this. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/** Who the handler is acting for. Read only: a tool cannot change a role. */
export interface ToolPerson {
  readonly id: string
  readonly role: Role
  readonly channel: string
  readonly channelUserId: string
  readonly displayName: string | null
  readonly language: string | null
}

/**
 * TOOL-4: what a handler is given.
 *
 * `facts`, the time helpers in `ctx.time` and `sendFile` arrive with the
 * features that own them, in M4 and M7. What is here already is enough to
 * write a tool that reads the agent's own tables and answers.
 */
export interface ToolContext {
  /** TIME-1: nothing reads the system clock directly. */
  readonly clock: { now(): Date }
  /**
   * TIME-2: the time helpers, all in the agent's timezone.
   *
   * TIME-3 is why a tool needs these rather than a date: a tool input that
   * holds a time takes the words the person said, and the tool resolves
   * them here. The brain never works out which day Friday is.
   */
  readonly time: TimeHelpers
  readonly person: ToolPerson
  /**
   * The turn this call is part of, for a tool that writes a row of
   * its own and has to say what caused it. Absent only where there
   * is no turn, which is a test calling a handler directly.
   */
  readonly turnId?: string | undefined
  /**
   * TOOL-4: what is remembered about this person, by key.
   *
   * Read only, and read as the turn started. A tool that wants to change
   * one calls `remember`, so there is one path that writes a fact and one
   * place that normalises its key.
   */
  readonly facts: Readonly<Record<string, string>>
  /**
   * The agent's own tables, already scoped to this agent (DATA-1). Use
   * `ctx.db.table("menu_items")`.
   */
  readonly db: {
    table<T = Record<string, unknown>>(name: string): unknown
  }
  /** Goes to the turn's record, not to the person. */
  readonly log: (message: string, detail?: Record<string, unknown>) => void
}

/** A JSON Schema object, as a brain receives it. */
export type JSONSchema = Record<string, unknown>

export interface ToolConditions {
  /** Plain sentences. The gate and routing both read these. */
  callWhen: string[]
  dontCallWhen: string[]
}

export interface ToolExamples {
  should: string[]
  shouldNot: string[]
}

/** What a builder writes. */
export interface ToolDefinition<TInput extends z.ZodObject = z.ZodObject> {
  name: string
  description: string
  input: TInput
  risk: Risk
  roles: Role[]
  conditions: ToolConditions
  /** TOOL-2: required when risk is irreversible. */
  confirmSummary?: (args: z.output<TInput>) => string
  examples: ToolExamples
  handler: (args: z.output<TInput>, ctx: ToolContext) => Promise<unknown>
}

/** A registered tool: the definition plus what the core derives from it. */
export interface Tool<TInput extends z.ZodObject = z.ZodObject> extends ToolDefinition<TInput> {
  /**
   * True for a tool the core itself ships (section 10).
   *
   * BUILTIN-1: these skip routing and are exposed whatever routing
   * decides, so a step has to be able to tell them apart from the
   * builder's own tools.
   */
  readonly builtin: boolean
  /** TOOL-1: the input schema, as a brain needs it. */
  readonly inputSchema: JSONSchema
  /** TOOL-3: description, then the call when and don't call when lines. */
  readonly brainDescription: string
  /** LOOP-8 step 6: check arguments before the handler ever sees them. */
  readonly parse: (args: unknown) => z.output<TInput>
  readonly safeParse: (args: unknown) => z.ZodSafeParseResult<z.output<TInput>>
}

/** Every problem found in one tool, in one error. */
export class ToolError extends Error {
  readonly problems: string[]

  constructor(what: string, problems: string[]) {
    const list = problems.map((problem) => `  - ${problem}`).join("\n")
    super(`${what} cannot be registered:\n${list}`)
    this.name = "ToolError"
    this.problems = problems
  }
}

const isFilled = (line: unknown): boolean => typeof line === "string" && line.trim().length > 0

function checkLines(value: unknown, path: string, problems: string[], why: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${path}: ${why}`)
    return
  }
  if (!value.every(isFilled)) {
    problems.push(`${path}: every line must be a sentence, and none may be blank`)
  }
}

/** TOOL-3. */
export function brainDescription(description: string, conditions: ToolConditions): string {
  return [
    description.trim(),
    "",
    "Call when:",
    ...conditions.callWhen.map((line) => `- ${line.trim()}`),
    "",
    "Don't call when:",
    ...conditions.dontCallWhen.map((line) => `- ${line.trim()}`),
  ].join("\n")
}

/** Drops $schema, which some tool calling APIs reject at the top level. */
function toBrainSchema(input: z.ZodObject): JSONSchema {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(input) as JSONSchema
  return rest
}

/**
 * TOOL-1 and TOOL-2. Validates a tool definition and derives what the core
 * needs from it. Throws `ToolError` listing everything wrong at once.
 */
export function defineTool<TInput extends z.ZodObject>(
  definition: ToolDefinition<TInput>,
): Tool<TInput> {
  return build(definition, false)
}

/**
 * The same rules, for a tool the core itself ships (section 10).
 *
 * Its own door rather than a flag on `defineTool`, because the one thing
 * `defineTool` must keep refusing is an agent tool wearing a built in
 * tool's name. This one insists on the opposite: the name has to be one of
 * section 10's, so nothing can smuggle an ordinary tool through here and
 * have it exposed on every step without routing.
 */
export function defineBuiltinTool<TInput extends z.ZodObject>(
  definition: ToolDefinition<TInput>,
): Tool<TInput> {
  if (!isBuiltinToolName(definition.name)) {
    throw new ToolError(`The tool ${definition.name}`, [
      `name: ${definition.name} is not one of section 10's built in tools, so it cannot be registered as one`,
    ])
  }
  return build(definition, true)
}

function build<TInput extends z.ZodObject>(
  definition: ToolDefinition<TInput>,
  builtin: boolean,
): Tool<TInput> {
  const problems: string[] = []
  const d = definition as unknown as Record<string, unknown>

  const name = typeof d["name"] === "string" ? d["name"] : ""
  if (!TOOL_NAME.test(name)) {
    problems.push(
      "name: must be 1 to 64 characters of letters, numbers, underscore or hyphen, so a brain can call it",
    )
  } else if (!builtin && isBuiltinToolName(name)) {
    problems.push(`name: ${name} is a built in tool, so an agent tool cannot take that name`)
  }

  if (!isFilled(d["description"])) {
    problems.push("description: required. The brain reads it to decide what this tool is for")
  }

  const input = d["input"]
  if (!(input instanceof z.ZodObject)) {
    problems.push("input: must be a z.object(...), because a brain sends arguments as an object")
  }

  if (!RISK_LEVELS.includes(d["risk"] as Risk)) {
    problems.push(`risk: must be one of ${RISK_LEVELS.join(", ")}`)
  }

  const roles = d["roles"]
  if (!Array.isArray(roles) || roles.length === 0) {
    problems.push("roles: required, and at least one role. Use end_user, operator, or both")
  } else if (!roles.every((role) => ROLES.includes(role as Role))) {
    problems.push(`roles: must be ${ROLES.join(" or ")}`)
  }

  const conditions = (d["conditions"] ?? {}) as Record<string, unknown>
  checkLines(
    conditions["callWhen"],
    "conditions.callWhen",
    problems,
    "required. Say when this tool should be called",
  )
  checkLines(
    conditions["dontCallWhen"],
    "conditions.dontCallWhen",
    problems,
    "required. Say when it should not be, so it is not called by mistake",
  )

  const examples = (d["examples"] ?? {}) as Record<string, unknown>
  checkLines(
    examples["should"],
    "examples.should",
    problems,
    "required. Give messages that should call this tool",
  )
  checkLines(
    examples["shouldNot"],
    "examples.shouldNot",
    problems,
    "required. Give messages that should not",
  )

  if (d["risk"] === "irreversible" && typeof d["confirmSummary"] !== "function") {
    problems.push(
      "confirmSummary: required for an irreversible tool. It is what the person is asked to confirm",
    )
  }

  if (typeof d["handler"] !== "function") {
    problems.push("handler: required")
  }

  if (problems.length > 0) {
    throw new ToolError(name === "" ? "This tool" : `The tool ${name}`, problems)
  }

  const schema = definition.input
  return Object.freeze({
    ...definition,
    builtin,
    inputSchema: toBrainSchema(schema),
    brainDescription: brainDescription(definition.description, definition.conditions),
    parse: (args: unknown) => schema.parse(args) as z.output<TInput>,
    safeParse: (args: unknown) => schema.safeParse(args) as z.ZodSafeParseResult<z.output<TInput>>,
  })
}
