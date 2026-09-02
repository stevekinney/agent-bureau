---
'@lostgradient/operative': minor
---

BREAKING (released as a minor under 0.x convention): Make `createSubagentTool`'s input and output projections directional and type-safe (AB-19).

`createSubagentTool` now accepts `agent: RunnableAgent<TOutput, THasOutput>` instead of a promise-returning `run` callback — `createAgent`'s returned agent satisfies this directly, with no adapter. `agentName` is retained as a separate option that names the child independently of any identity the agent object carries; it is passed verbatim to `agent.run(input, { agentName, signal, traceContext, withTraceContext })`, so a real `createAgent` child receives the parent tool call's abort signal and trace context, plus this new `withTraceContext` option, exactly as the parent run itself does.

`mapInput` is renamed `toAgentInput`: it receives the tool's parsed, Zod-validated arguments (not `unknown`) and returns `AgentInput` (a string, or `{ conversation }` to resume an existing `ConversationHistory` under `createAgent`'s snapshot semantics). `mapOutput` is renamed `toToolOutput`: it is a pure projection over a successful `SuccessfulRunResult<TOutput, THasOutput>`, never invoked for a non-success terminal, and may return synchronously or via a `Promise`. Omit `toToolOutput` for a schema-less child and the tool returns a plain string (`result.content`), matching the prior default.

Every non-success terminal — abort, execution error, tripwire, budget exceeded, elicitation denied, maximum steps, or a clean stop whose output failed schema validation — now rejects with the new `SubagentRunError` (`kind: 'tool'`, code `SUBAGENT_RUN_FAILED`), which carries the child's full terminal `RunResult` as `.result`. `treatMaximumStepsAsError` is removed with no replacement: every non-success terminal always rejects.

New exports: `SubagentRunError`, `RunnableAgent`, `AgentInput`, `AgentRunContext`, `SuccessfulRunResult`, and `isSuccessfulRunResult`. `createAgent`'s returned `StandaloneAgent.run` now accepts an optional second `AgentRunContext` argument (`{ signal, traceContext, withTraceContext, agentName }`), threaded into the run's `RunOptions` — this is additive and backward compatible with every existing `agent.run(input)` call site.

AB-70's `summaryAssetPolicy` amendment to this issue — controlling how non-text `parts` are represented in a capped summary — is deferred to AB-73, which introduces the `parts` field on `RunResult` this amendment depends on; it is not implemented here.

**Migration**: rename `run` to `agent` (pass a real `RunnableAgent`, e.g. `createAgent`'s result, rather than a callback), rename `mapInput` to `toAgentInput`, rename `mapOutput` to `toToolOutput`, and remove any `treatMaximumStepsAsError` usage. A caller matching on thrown error message text should match on `SubagentRunError` and its `.result.finishReason`/`.result.error` instead.
