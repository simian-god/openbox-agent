// Section 10 of the Spec. The tools themselves are built across M4 to M9;
// the names live here from the start so TOOL-2 can reject an agent tool
// that would shadow one.

export const BUILTIN_TOOL_NAMES = [
  "remember",
  "forget_fact",
  "start_task",
  "update_task",
  "switch_task",
  "close_task",
  "search_knowledge",
  "escalate",
  "take_over",
  "resume",
  "block",
  "unblock",
  "approve_knowledge",
  "reject_knowledge",
  "flag",
  "list_handovers",
  "erase_person",
  "export_person",
] as const

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number]

export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name)
}
