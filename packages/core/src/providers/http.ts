// The one piece of `fetch` the HTTP providers use, so a contract test can
// stand in for it without reproducing the runtime's whole fetch type
// (TEST-3). DEP-1 keeps every real call inside this directory.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>
