---
'@lostgradient/operative': minor
---

Deprecates `BudgetExceededEvent` (AB-365).

AB-231 settled budget-exceeded accounting through `RunCompletedEvent`'s `finishReason: 'budget-exceeded'` rather than a dispatched event, so `BudgetExceededEvent` has never had a production dispatch site in `packages/operative/src` — a subscriber can never receive it. `BudgetExceededEvent` and its `OperativeEventClassMap` entry now carry `@deprecated` JSDoc pointing at `run.completed`'s `finishReason` and AB-231. Nothing is removed in this change; the class and map entry stay exported for this minor and are removed in the next major.
