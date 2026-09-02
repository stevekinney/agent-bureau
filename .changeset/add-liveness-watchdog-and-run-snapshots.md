---
'@lostgradient/operative': minor
---

Add the liveness watchdog module and `snapshot()`/`subscribeSnapshot()` to `ActiveRun`, `AgentRun`, and `DiagnosticAgentRun` (AB-88, delivered by AB-214/obs-01).

`packages/operative/src/liveness/` is new, exporting AB-88's binding types (`LivenessSnapshot`, `LivenessSubjectKind`, `LivenessAssessment`, `LivenessReachability`, `LivenessProgressState`, `DeclaredWait`, `DeclaredWaitReason`, `StallPolicy`, `LivenessClockSource`, `LivenessSuspensionBehavior`, `LivenessRecoveryRule`, `LivenessEvidenceSource`, `LivenessEvidenceEntry`, `LivenessObservable`) and `createStallWatchdog(policy, clock)` — the single timer-agnostic implementation of `StallPolicy`'s cadence/grace/jitter/missed-pulse math, evidence-source isolation, attempt fencing, and `pause-on-suspected-suspension`. `packages/operative/src/liveness/policies.ts` exports `LIVENESS_POLICY_VERSION` (`'ab-88/2026-09-01'`) and every `StallPolicy` row AB-88's table names (`agent-run.provider-turn`, `tool-call`, `session.monitor`, `scheduler-task`, `gateway-connection`, `background-evaluation`, `webhook-delivery`, `weft-activity`, `weft-worker`, `weft-task`, `weft-stream`), with `jitterMs` fixed at 10 percent of `cadenceMs` (50ms floor) per this issue's coordinator ruling.

`ActiveRun` (`packages/operative/src/create-run.ts`, `durable/active-run-adapter.ts`), `AgentRun`, and `DiagnosticAgentRun` (`packages/operative/src/agent-run.ts`) all gain:

```typescript
snapshot(): LivenessSnapshot & { kind: 'agent-run' };
subscribeSnapshot(
  observer: (snapshot: LivenessSnapshot & { kind: 'agent-run' }) => void,
  options?: { signal?: AbortSignal },
): Subscription;
```

`subscribeSnapshot` delivers the current snapshot synchronously before returning, then a new snapshot on every explicit revision-advancing event (a recorded pulse, a status transition, or the terminal result); already-terminal work delivers the terminal snapshot once and no further calls. Both additions are structural and non-breaking.

A standalone (non-Bureau) in-memory run now mints a process-local id at construction through a local identifier seam (`packages/operative/src/liveness/identifiers.ts`) whenever `RunOptions.runId` is absent, rather than leaving curated `tool.*` bubble events and `createSubagentTool`'s per-call `parentRunId` stamped with an empty string. A Bureau- or caller-supplied `runId` is always used as-is, so this id stays identical to whatever id `bureau.store.register` uses for the same run.

`packages/bureau`'s `getRun(id)` DTO gains a `liveness: LivenessSnapshot` field (plain-data, JSON-safe), and `Bureau` gains `subscribeRunSnapshot(runId, observer, options?)`, delegating to the underlying `ActiveRun`'s `subscribeSnapshot`; it throws `NOT_FOUND` for an unknown run id, matching `abortRun`'s convention. `RunSummary`/`listRuns` are unchanged.

`packages/operative/src/scheduler/create-heartbeat.ts`'s `createHeartbeat` gains a JSDoc note (no signature change) stating it schedules new recurring work and is not a run-liveness or watchdog primitive.
