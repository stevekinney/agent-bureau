---
'armorer': minor
---

A `loop-blocked` toolbox rejection now dispatches a companion `error` event carrying the same rejected `ToolExecutionResult`, mirroring the existing `budget-exceeded`-then-`error` pattern (AB-231, ratifying AB-87's armorer-surface decision). Previously `loop-blocked` returned its `blocked` result directly with no companion `error` event, so operative's generic toolbox-event forwarding never observed a blocked call — the run layer saw no signal at all. `loop-warning`'s non-blocking, advisory-only semantics are unchanged.

Also adds `TOOLBOX_BUDGET_EXCEEDED_MARKER` and `isToolboxBudgetExceededToolError` (with the `ToolboxBudgetExceededToolError` type), a provenance marker the toolbox's own `checkBudget` path stamps onto the `ToolError` it throws in `failFast` mode. `ToolError.code` alone is public, user-controlled data — a tool's own `execute()` can throw an error whose `code` also normalizes to `'BUDGET_EXCEEDED'` without being a toolbox-accounting rejection — so a consumer that needs to distinguish a genuine toolbox-level budget rejection (such as operative's `BudgetExceededError` reclassification, see the companion `@lostgradient/operative` changeset) checks for this marker instead of trusting `code` alone. The marker is symbol-keyed and therefore invisible to `JSON.stringify`, `Object.keys`, and structured-clone serialization.
