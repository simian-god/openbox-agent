// The version of this package, as source rather than as JSON.
//
// LEARN-2 folds it into every agent's version hash, so a core upgrade shows
// up as a new version even when the agent itself did not change. Importing
// package.json would tie the build to a JSON module setting, so the number
// lives here and a test holds it to package.json.
export const CORE_VERSION = "0.0.0"
