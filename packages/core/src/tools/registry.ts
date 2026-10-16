// The agent's tools, looked up by name and filtered by role.
import { isBuiltinToolName } from "./builtins.ts"
import { ToolError, type Role, type Tool } from "./define.ts"

export interface ToolRegistry {
  /** Every agent tool, in the order it was registered. */
  all(): Tool[]
  get(name: string): Tool | undefined
  /** ROLE-3: the tools this role is allowed to use. */
  forRole(role: Role): Tool[]
}

/**
 * TOOL-2: two tools cannot share a name, and no agent tool may take a built
 * in tool's name. Both are checked here as well as in `defineTool`, because
 * a clash only exists once there is more than one tool.
 */
export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const problems: string[] = []
  const byName = new Map<string, Tool>()

  for (const tool of tools) {
    if (byName.has(tool.name)) {
      problems.push(`${tool.name}: two tools share this name`)
      continue
    }
    if (isBuiltinToolName(tool.name)) {
      problems.push(`${tool.name}: this is a built in tool's name`)
      continue
    }
    byName.set(tool.name, tool)
  }

  if (problems.length > 0) throw new ToolError("These tools", problems)

  const registered = [...byName.values()]

  return {
    all: () => [...registered],
    get: (name: string) => byName.get(name),
    forRole: (role: Role) => registered.filter((tool) => tool.roles.includes(role)),
  }
}
