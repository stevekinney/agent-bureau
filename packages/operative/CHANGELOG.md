# @lostgradient/operative

## 0.2.1

### Patch Changes

- Updated dependencies [a6e18f2]
  - armorer@2.0.0

## 0.2.0

### Minor Changes

- 00e34f2: `SessionHandle.recover()` now surfaces a failed durable re-attach through `emitter` instead of returning an indistinguishable `null`. `SessionRecoverEvent` gains a `failures` array (each entry carrying the rejected `runId` and its `error`), populated whenever `engine.resume()` rejects while re-attaching to a session's `running` refs — distinguishing "nothing to resume" (`failures: []`) from "resume was attempted and failed" (`failures.length > 0`). `recover()` itself keeps returning `AgentRun | null` and never throws.
- 8e70c14: Add `createLazyGenerate` for shared, retryable lazy loading of selected generate functions with invocation-local abort handling.
- 31d4780: Wire `@lostgradient/operative` into the Changesets and trusted-publishing release pipeline.
- f4fd0ed: Rename validated run data from `structuredOutput` to `output`, reject old persisted run-result shapes explicitly, add cached `unwrap()` and typed output accessors, and expose diagnostic handles for durable runs whose originating agent definition is unavailable.
- d3670e3: `createAgent`'s standalone `CreateAgentOptions` now encodes `tools`/`toolbox`/`permissions` exclusivity at the type level: `tools` + `toolbox`, `toolbox` + `permissions`, and all three together are now compile-time errors, matching the existing runtime guard. `tools`, `permissions`, `tools` + `permissions`, and `toolbox` alone remain valid, as does passing no tool configuration, including when `tools`/`permissions` are forwarded as already-optional (`T | undefined`-typed) values.

  `CreateAgentOptions` is now a `type` (a union-based intersection), not an `interface` — a consumer that previously wrote `interface MyOptions extends CreateAgentOptions` for the full options bag needs `type MyOptions = CreateAgentOptions & { ... }` instead. Extending or declaration-merging onto just the non-exclusive fields (`generate`, `instructions`, `stopWhen`, etc.) still works via the newly exported `CreateAgentOptionsBase` interface.

### Patch Changes

- e45b40c: Fix `session.recover()` leaving a session's `RunRef` stranded at `status: 'running'` forever when a recovered durable run reaches a terminal state before `recover()` resumes it. `engine.resume()` rejecting for an already-terminal workflow now reconciles the persisted `RunRef` (and recovered conversation history) to the workflow's actual terminal status instead of being silently swallowed; an unknown `runId` is left untouched.
- dfc571b: Optimize session listing with a maintained summary index while preserving compatibility with legacy session records.
- Updated dependencies [22de20a]
- Updated dependencies [ed70acf]
- Updated dependencies [aff071a]
- Updated dependencies [22de20a]
- Updated dependencies [d947aad]
- Updated dependencies [d229843]
- Updated dependencies [8bddca2]
  - conversationalist@1.0.0
  - armorer@1.0.0
