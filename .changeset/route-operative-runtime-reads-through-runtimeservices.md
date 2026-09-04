---
'@lostgradient/operative': minor
---

Routes the remaining production-source real-runtime reads AB-292's scan flagged through `RuntimeServices` (AB-92/AB-252/AB-325), so a manual runtime controls them:

- `createAgent`'s `generationProfile.freshness` now reads the agent's already-resolved `runtime.clock.nowISO()` instead of `new Date()`.
- `createDeferredAgentRun` (and `createLazyAgent`) gain an optional `runtime?: RuntimeServices` parameter/option backing the synthetic liveness snapshot's `startedAt`/`observedAt` for the window before the underlying agent resolves. Additive — `bureau`'s existing call sites are unaffected.
- `createDefaultRunIdentifierSeam` (`@lostgradient/operative/liveness`) gains an optional `runtime?: RuntimeServices` parameter and now mints ids through `runtime.identifiers.next('run')` instead of a bare `crypto.randomUUID()`. `createActiveRun` (`create-run.ts`) already read its standalone-run id straight from its own resolved runtime and no longer reaches this seam by default; it remains as the `CreateActiveRunDependencies.identifiers` explicit-override escape hatch.
- `createActiveRunLiveness`'s `ActiveRunLivenessOptions` gains `runtime?: RuntimeServices`, backing `startedAt`/`lastTransitionAt` and, when `options.clock` is not separately supplied, the watchdog's monotonic/timer seam. `options.clock` still takes precedence over `runtime` for that seam when both are supplied (unaffected default behavior).
- `createModelCatalog`'s `CreateModelCatalogOptions` gains `runtime?: RuntimeServices`, backing the default `now` when `options.now` is not supplied.
- `select`'s `SelectOptions` gains `runtime?: RuntimeServices`, backing the default `now`/`newPlanId` when those are not supplied.

Every new option is additive and defaults to the real `RuntimeServices` implementation (`createDefaultRuntimeServices` from `lifecycle`), matching each function's pre-existing default behavior exactly — no public factory changes behavior when no runtime is supplied.
