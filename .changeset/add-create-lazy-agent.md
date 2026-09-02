---
'@lostgradient/operative': minor
---

Add `createLazyAgent` — type-preserving lazy loading for a whole `RunnableAgent` (AB-21), the agent-level counterpart to `createLazyGenerate` (AB-20).

`createLazyAgent(loader, options?)` accepts a loader that returns (or resolves to) a `RunnableAgent<O, H>` and returns a `RunnableAgent<O, H>` itself — the same shape as an eager `createAgent()` result, so it slots into an `AgentDefinitions` map without unwrapping. Callers select the module export inside the loader (`() => import('./agent').then((m) => m.agent)`); there is no `{ default }` unwrapping and no selector overload.

`run()` remains synchronous even before the underlying agent has loaded: it returns an `AgentRun` handle immediately, buffering events emitted before resolution and delegating `result()`/`unwrap()`/`output()` to the real handle once it exists. Each `run()` call owns an isolated `waiting → started → terminal` cancellation state — `abort()` before resolution completes means the underlying agent's own `run()` is never called; `abort()` after resolution forwards to the real handle exactly once.

The first successful load is cached and shared across concurrent `run()` calls, and a failed load clears only that pending load so a later `run()` retries — mirroring `createLazyGenerate`. A loader failure surfaces `AsyncDefinitionLoadError` (kind `'load'`); a resolved value that isn't a valid `RunnableAgent`, or a `run()` return value that isn't a valid `AgentRun` (missing `result`, `abort`, iteration, or `[Symbol.dispose]`), surfaces the new `AgentContractError` (kind `'contract'`, code `'INVALID_AGENT_HANDLE'`) instead — not retried, since the load itself succeeded.

This also adds the underlying public types this issue and its predecessors describe (`AgentInput`, `AgentRunContext`, `RunnableAgent`, `OPERATIVE_RESOLVE_RUN_OPTIONS`) and a matching `[OPERATIVE_RESOLVE_RUN_OPTIONS]` capability on `createAgent`'s returned agent, so a durable engine can resolve the same `RunOptions` bag `run()` would build without invoking the in-memory `run()` handle.
