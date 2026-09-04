---
'@lostgradient/operative': patch
---

Fix `requestHumanInput` not visibly parking a durable run (AB-336).

Two independent defects, both in `packages/operative`:

- **Fresh dispatch (observability):** the durable park mechanism itself was already correct — `stepResult.pendingHumanWait` forces the step loop to break regardless of `stopWhen`, and the workflow's own `yield* ctx.waitForSignal(signalName)` genuinely parks — but nothing moved the run's `LivenessSnapshot.status` off `'running'` for it, leaving `deriveAssessment`'s `'waiting'` branch unreachable. `ActiveRunLiveness` gains `beginWait`/`endWait`, which pair `status: 'waiting'` with a `DeclaredWait` (AC1's "present iff waiting" invariant, enforced even when a status change races the wait via `setStatus`/`settle`) as one atomic revision. Both `createDurableActiveRun` and `reattachDurableActiveRun` wire this to a `HumanWaitParkedEvent`/next-`StepStartedEvent` pair; the wait's `reason` is `'review'` when `requestHumanInput`'s `prompt` is supplied and `'signal'` otherwise, matching `SessionHandle`'s existing derivation (AB-88). `setStatus`'s parameter type now excludes `'waiting'`, since that combination is reachable only through `beginWait`.
- **Recovery (the actual root cause a caller could observe as a run "looping instead of parking"):** a run recovered mid-step whose replay called `requestHumanInput` found no such tool at all — `bureau`'s recovery-path toolbox reconstruction never wired the opt-in durable-park tools in, only the fresh-dispatch path did. `pendingHumanWait` never got set, the durable park never fired, and the step loop simply continued to the next step. Fixed in `bureau` (private, no changeset) by sharing the wiring between both paths.

Both fixes are additive: `ActiveRunLiveness` gains two new methods and `LivenessSnapshot.declaredWait` a new legal producer; nothing narrows or removes existing behavior.
