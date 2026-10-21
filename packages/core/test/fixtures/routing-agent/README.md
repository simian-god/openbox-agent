# routing-agent

Test data, not an example to learn from. `examples/demo-agent` is the
example.

This is the agent C8 is measured on. It exists because C8 compares the same
turns with and without routing, and routing only runs above
`routingMinTools` agent tools (ROUTE-1). The demo agent has one tool, so it
cannot answer the question at all. The demo agent is rebuilt by the skill at
T11.1, and C8 can move onto it then.

Eight tools across all three risk levels, each with the conditions and
example messages TOOL-1 asks for, plus `examples/routing.jsonl` for the
labels a single message cannot carry.

Run it:

```
bun run c8 --dir packages/core/test/fixtures/routing-agent
```

That makes real requests to the brain and the decision model, so it needs
`OPENROUTER_API_KEY` and it costs money. Two brain calls per labeled
example, one per arm.
