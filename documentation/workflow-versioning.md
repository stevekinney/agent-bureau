# Workflow versioning for in-flight durable runs (AB-10)

Runbook: what happens to a durable `agentRun` that is mid-flight when you deploy
changed agent/workflow code, and how to observe it.

## The problem

A durable run's resume position is a Weft checkpoint (event log + cursor), not a
saved snapshot of your code. When a process crashes or restarts, Weft's engine
resumes the run by re-registering the SAME workflow type (`agentRun`) and
replaying the generator from the top, short-circuiting completed steps via
`ctx.memo`. If the deployed code changed shape between the crash and the
restart — a different tool schema, a changed step body, a renamed hook — the
replay can diverge from what the checkpoint expects, in ways that range from
harmless to a hard failure mid-replay.

Weft has no built-in mechanism to _prevent_ this; it has a version-stamp-and-
compare primitive (`WorkflowDefinition.version`, checked on recovery), but
using it as shipped is unsafe for a fleet: a single mismatched run's
`VersionMismatchError` propagates out of `engine.recoverAll()` uncaught and
aborts recovery of every OTHER in-flight run in the same boot batch (filed
upstream — weft ticket `e99c2ae2-40ae-4f0e-9964-8e39f6691e8d`). Operative
therefore implements its own, independent stamp-and-compare.

## What operative does today: pin-and-warn

1. **Stamp.** Pass a version identifier — your app's `package.json` version, a
   deploy SHA, whatever you use to distinguish one deploy from the next — to
   `createRunWorkflow(checkpointStore, { version })` (or, via the bureau,
   `BureauOptions.workflowVersion`). Every new run's checkpoint cursor records
   this as `RunCursor.workflowVersion` at creation and carries it unchanged
   across every subsequent step.

2. **Compare on recovery.** Pass the SAME identifier to
   `createRunEngine({ runWorkflowVersion })` (or, via the bureau,
   `BureauOptions.workflowVersion` — one value threads to both). On every
   recovered run, before its dependencies are rebuilt, the engine compares the
   checkpoint's stamped `workflowVersion` against `runWorkflowVersion`.

3. **Warn, never block.** A mismatch does NOT fail, cancel, or alter the
   recovered run in any way — the run resumes and completes against the
   CURRENTLY DEPLOYED code, exactly as it would without versioning configured.
   The mismatch is only OBSERVED:
   - `createRunEngine({ onWorkflowVersionMismatch })` fires once per
     mismatched run with a `WorkflowVersionMismatchEvent` (`runId`,
     `storedVersion`, `registeredVersion`).
   - The bureau wires this internally and logs a `console.warn` per
     mismatched run at boot.
   - `classifyRecoveredRun` (`packages/bureau/src/create-bureau.ts`) returns
     `'reattach-version-mismatch'` instead of plain `'reattach'` for an
     otherwise-reattaching run the engine flagged — so any code branching on
     the verdict can alert, tag, or otherwise treat it distinctly, while the
     run itself is still reattached and observed like any other recovered run.

This is deliberately the weakest safe mechanism: it never surprises an
operator by silently killing a batch of in-flight work on deploy (the failure
mode Weft's own throw-based check has today), and it gives you a clear signal
— log lines plus a distinct classification verdict — to decide whether the
drift matters for your specific change.

## What this does NOT do

- It does not pin a recovered run to the OLD code (no per-run version
  isolation / no side-by-side old-and-new worker execution). A resumed run
  always executes against whatever code is currently registered.
- It does not run migration hooks or transform old checkpoint shapes to a new
  schema. If your change is not backward-compatible with an in-flight run's
  checkpoint (e.g. a step body that reads a field the old checkpoint never
  wrote), the mismatch event tells you it happened, but does not fix it.
- It is not a general workflow-history replay-safety check (Temporal's
  "non-determinism" detection). It only compares an opaque version STRING you
  choose; it has no idea whether your actual change is replay-safe.

## Deploy guidance

- **Additive changes** (new optional tool, new hook, new step-body branch
  reachable only by future runs) are safe to deploy with runs in flight. Bump
  `workflowVersion` anyway so drift is visible in logs/dashboards, but no
  action is needed.
- **Breaking changes** (removed/renamed tool a resumed run's checkpoint may
  reference, a step-body restructuring that changes what a given step index
  means) are NOT safe for runs that are mid-flight at deploy time. Before
  shipping:
  - Drain in-flight runs first (let them finish, or explicitly cancel them)
    if your traffic pattern allows a brief drain window, OR
  - Keep the OLD code running (a canary/blue instance) until every run
    stamped with the old version has completed, using the
    `onWorkflowVersionMismatch` / `'reattach-version-mismatch'` signal to know
    when the last old-stamped run has drained, OR
  - Accept that recovered old-stamped runs may fail mid-replay against the new
    code, and treat that as an ordinary run failure (same as any other
    terminal error) — acceptable for low-stakes / cheaply-retryable runs.
- **Always bump `workflowVersion` on deploy** (wire it to your build's
  version/SHA, not a hand-maintained constant) — an unbumped version defeats
  the whole mechanism, since every recovered run then compares equal to
  "current" regardless of what actually changed.

## Where to look

- `packages/operative/src/durable/types.ts` — `RunCursor.workflowVersion`.
- `packages/operative/src/durable/run-workflow.ts` —
  `createRunWorkflow`'s `version` option (the stamp).
- `packages/operative/src/durable/create-run-engine.ts` —
  `CreateRunEngineOptions.runWorkflowVersion` / `onWorkflowVersionMismatch`
  (the compare + observe).
- `packages/operative/src/events.ts` — `WorkflowVersionMismatchEvent`.
- `packages/bureau/src/create-bureau.ts` — `classifyRecoveredRun`'s
  `'reattach-version-mismatch'` verdict and its boot-recovery wiring.
- `packages/bureau/src/types.ts` — `BureauOptions.workflowVersion`.
