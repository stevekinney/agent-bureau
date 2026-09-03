---
'@lostgradient/operative': patch
---

Fix curated `tool.*` bubble events (`tool.started`, `tool.settled`, `tool.progress`, `tool.policy-denied`) being silently dropped for any step whose `selectTools` hook swaps in a different toolbox (AB-294).

`create-run.ts` and `durable/active-run-adapter.ts` (both the fresh-start and recovered-run drivers) previously registered these four listeners once, on the run's original toolbox, outside the AB-239 per-step subscription seam. They now move onto that same `StepDeps.onStepToolbox` bracket — opened with the step's resolved toolbox at step start, closed at the step's actual end — so a swapped step toolbox's tool events reach the run emitter exactly as an unswapped step's do, with no duplicate delivery when the step toolbox is the original instance.
