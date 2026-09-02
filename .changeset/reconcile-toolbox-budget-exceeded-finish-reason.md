---
'@lostgradient/operative': minor
---

A toolbox-level, per-call `failFast` budget rejection now sets `run.completed`'s `finishReason` to `'budget-exceeded'` instead of falling through to `'error'` (AB-231, ratifying AB-87's `ToolboxBudgetExceededEvent` reconciliation decision). Previously armorer's `checkBudget` path threw a generic `ToolError` stamped `code: 'BUDGET_EXCEEDED'` — armorer sits below operative in the dependency graph and cannot construct or throw operative's `BudgetExceededError` directly — so the rejection reached the run layer only as a generic `tool.error`, with the budget-exceeded semantics lost at the `finishReason` classification site.

A thrown armorer `ToolError` is now re-classified as a `BudgetExceededError` upstream of `makeErrorResult`'s `instanceof` check only when it carries armorer's new `TOOLBOX_BUDGET_EXCEEDED_MARKER` provenance marker (see the companion `armorer` changeset) — not merely a matching `code: 'BUDGET_EXCEEDED'`, since a tool's own `execute()` can throw an error whose `code` coincidentally normalizes the same way without being a toolbox-accounting rejection at all. Every other tool error, including a tool-defined one with that same code, is unaffected.

`BudgetExceededError` now also accepts an optional second `cause` argument, and the reclassification site passes the original armorer `ToolError` through as that cause — so `RunResult.error`, `onRunError`, and `serializeAgentRunError` still expose its underlying `code`/`category`/`retryable` diagnostics after reclassification, matching what `toAgentRunError` already preserves for every other generically-wrapped tool error.
