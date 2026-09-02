---
'@lostgradient/operative': minor
---

Implemented AB-232: `run-step.ts`'s manually iterated `beforeGenerate` and `afterGenerate` hook waterfalls now honor `HookRegistry`'s registry-level `onError` fallback instead of bypassing it.

- `lifecycle`'s `HookRegistry` gains a public `onError` getter that exposes the registry-wide error handler passed to its constructor — the same fallback `run()` already applies internally when a handler has no per-registration `onError`. No second code path was added to `run()`; the getter simply reads `registryOptions.onError`, documented in the lifecycle README.
- Both the `beforeGenerate` and `afterGenerate` waterfalls in `packages/operative/src/run-step.ts` now wrap each manually invoked handler in a try/catch that resolves `entry.options.onError ?? hooks.onError` — the identical precedence `HookRegistry.run()` uses — and either skips to the next handler (`'continue'`), rethrows (`'abort'` or no configured handler), matching `run()`'s behavior exactly.
