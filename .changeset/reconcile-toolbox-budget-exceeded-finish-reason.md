---
'@lostgradient/operative': minor
---

A toolbox-level, per-call `failFast` budget rejection now sets `run.completed`'s `finishReason` to `'budget-exceeded'` instead of falling through to `'error'` (AB-231, ratifying AB-87's `ToolboxBudgetExceededEvent` reconciliation decision). Previously armorer's `checkBudget` path threw a generic `ToolError` stamped `code: 'BUDGET_EXCEEDED'` — armorer sits below operative in the dependency graph and cannot construct or throw operative's `BudgetExceededError` directly — so the rejection reached the run layer only as a generic `tool.error`, with the budget-exceeded semantics lost at the `finishReason` classification site. A thrown armorer `ToolError` carrying `code: 'BUDGET_EXCEEDED'` is now re-classified as a `BudgetExceededError` upstream of `makeErrorResult`'s `instanceof` check; every other tool error is unaffected.
