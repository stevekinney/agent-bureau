---
'@lostgradient/operative': minor
---

Delete the synchronous builder chain (`bureau/builder`, `createBureauRuntime`, `createAgentRegistry`, `RegistryAgent`, `bureau-types`) and the `AgentBuilder`/`BureauBuilder`/`AgentTable`/`NormalizeAgents` types that supported it (AB-22), per AB-15's ratified typed Agent/Bureau contract. `createAgent`'s returned agent no longer needs to satisfy the old `AgentBuilder` shape — it satisfies `RunnableAgent<O, H>` instead, unchanged from AB-21.

`createHandoffTool`'s `HandoffTarget` no longer accepts a `RegistryAgent`; it takes `{ agentName: string; agent: RunnableAgent }` — the same `RunnableAgent` shape `createAgent`/`createLazyAgent` already return, so no separate registry wrapper is needed to hand an agent to `createHandoffTool`.

`createDeferredAgentRun` (previously file-private to `create-lazy-agent.ts`) is now exported: it wraps an async agent-resolution call in a synchronously-returned `AgentRun`, buffering events and settling `result()`/`unwrap()`/`output()`/iteration once the promise resolves. `bureau`'s new `bureau.run(name, input, options?)` (AB-22) reuses it unchanged to defer bureau's own async per-run setup (durable-engine dispatch) behind the required synchronous return.

The root `bureau` package (private, no changeset) gains the typed `AgentDefinitions` catalog: `createBureau({ agents, ... })` now requires an `agents` map (pass `{}` if unused), exposed read-only as `bureau.agents` (`get`/`find`/`has`/`names`/`entries`/`query`) and dispatched by name through the new synchronous `bureau.run(name, input, options?)`. `createSupervisor` and `createAgentDiscoveryTool` moved from `operative` to `bureau`, rebuilt against `BureauAgentCatalog<D>` in place of the deleted `AgentRegistry`. `bureau.run` is additive to the existing session/durability-backed `createRun` — a bureau may use either, both, or neither.
