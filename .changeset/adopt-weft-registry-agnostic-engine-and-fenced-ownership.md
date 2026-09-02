---
'@lostgradient/operative': minor
---

Adopted `@lostgradient/weft` 0.23.1 across the durable run layer.

- Replaced the local `AnyRunEngine = Engine<any, any>` erasure (and its explicit-`any` lint suppression) with weft's own package-root `RegistryAgnosticEngine` type. Production code no longer casts an engine to `any` or to `RegistryAgnosticEngine` — `Engine.create({ workflows })`'s result is directly assignable to the new type.
- Added a host-configurable `ownership` option to `createRunEngine` (`CreateRunEngineOptions.ownership`), defaulting to `'none'` — today's behavior is unchanged. Passing `'workflow-lease'` lets more than one engine safely share a durable store: weft fences each workflow to exactly one engine before its generator runs, so a second engine racing to resume the same workflow fails closed (`WorkflowClaimUnavailableError`) instead of double-executing it. Requires a storage backend with the `conditionalBatch` capability (`MemoryStorage` and `SQLiteStorage` both qualify).
- Added `workflowClaimTtlMs`/`workflowClaimRenewIntervalMs` passthrough options for tuning `'workflow-lease'` claim timing.
- **Known limitation:** a weft 0.23.1 defect makes `ownership: 'workflow-lease'` incompatible with the scheduler's suspend/resume preemption path (`createScheduler`'s `suspendAndDetach` → `resumeDurableRunResult`) — `engine.suspend()` releases a workflow's claim as a side effect of reusing weft's terminal-commit code path, so a same-engine `engine.resume()` right after throws instead of re-acquiring. Do not enable `'workflow-lease'` on an engine a preempting scheduler attaches to until this is fixed upstream. This is why `'workflow-lease'` is opt-in rather than the new default.

**Breaking for consumers with an existing durable store:** weft 0.23 advances its persisted-data schema from version 1 to version 2 with no in-place migration — a store written by weft 0.22.x or earlier is rejected with `PersistedDataIncompatibleError` when opened under this release. Plan a cutover (new store, or an offline migration) before deploying.
