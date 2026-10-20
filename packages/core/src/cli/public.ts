// What the public entry re-exports from the CLI (PKG-1, PKG-2).
//
// Deliberately not `cli/index.ts`: that file is the executable, and an
// agent project that imports openbox-agent must not pull the executable
// back in while `openbox chat` is still loading that project.
export * from "./project.ts"
export * from "./terminal.ts"
export * from "./chat.ts"
