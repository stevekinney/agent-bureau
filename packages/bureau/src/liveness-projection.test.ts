import type { EngineLeaseHealth } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  buildTaskDiagnosticsInput,
  type LivenessSnapshotEnvelope,
  projectEngineLeaseSnapshot,
  projectStreamLivenessSnapshot,
  projectTaskLivenessSnapshot,
  projectWorkerLivenessSnapshot,
  type TaskDiagnosticsFilter,
  type WeftLivenessSource,
  type WorkerDiagnosticsResult,
} from './liveness-projection';

function envelope(overrides: Partial<LivenessSnapshotEnvelope> = {}): LivenessSnapshotEnvelope {
  return {
    id: 'subject-1',
    startedAt: '2026-09-03T00:00:00.000Z',
    revision: 1,
    lastTransitionAt: '2026-09-03T00:00:00.000Z',
    ownership: 'independent',
    detached: false,
    durability: 'durable',
    cancellable: false,
    attempt: 1,
    observedAt: 1_000,
    ...overrides,
  };
}

function makeSource(overrides: Partial<WeftLivenessSource> = {}): WeftLivenessSource {
  return {
    getLeaseHealth: () => ({ mode: 'none', status: 'disabled', holdsLease: false }),
    getWorkerDiagnostics: async () => ({ worker: null }),
    getTaskDiagnostics: async () => ({
      items: [],
      summary: {
        stuckQueued: 0,
        staleInflight: 0,
        retryStorms: 0,
        allWorkersAtCapacity: 0,
        deadLettered: 0,
        delayed: 0,
        unadoptedTerminal: 0,
      },
      limit: 50,
    }),
    ...overrides,
  };
}

describe('projectEngineLeaseSnapshot', () => {
  it('reports no lease evidence and healthy assessment when lease mode is disabled', () => {
    const source = makeSource();
    const snapshot = projectEngineLeaseSnapshot(source, envelope());
    expect(snapshot.kind).toBe('weft-engine-lease');
    expect(snapshot.lease).toBeUndefined();
    expect(snapshot.reachability).toBe('unknown');
    expect(snapshot.assessment).toBe('healthy');
  });

  it('populates epoch only when Engine.getLeaseHealth() reports an active, confirmed holder record', () => {
    const health: EngineLeaseHealth = {
      mode: 'lease',
      status: 'healthy',
      holdsLease: true,
      holderId: 'engine-a',
      heldSince: 100,
      expiresAt: 5000,
      lastRenewedAt: 4000,
      fencingEpoch: 7,
    };
    const source = makeSource({ getLeaseHealth: () => health });
    const snapshot = projectEngineLeaseSnapshot(source, envelope());
    expect(snapshot.lease).toEqual({
      holderId: 'engine-a',
      expiresAt: 5000,
      epoch: 7,
      source: 'weft-workflow-lease',
    });
    expect(snapshot.reachability).toBe('reachable');
    expect(snapshot.assessment).toBe('healthy');
  });

  it("carries no fabricated epoch for a detached/deposed (contested) engine, per getLeaseHealth's own documented behavior", () => {
    const health: EngineLeaseHealth = {
      mode: 'lease',
      status: 'contested',
      holdsLease: false,
      holderId: 'engine-b',
      heldSince: 100,
      expiresAt: 5000,
      lastRenewedAt: 4000,
      fencingEpoch: 9,
      lossReason: 'deposed',
    };
    const source = makeSource({ getLeaseHealth: () => health });
    const snapshot = projectEngineLeaseSnapshot(source, envelope());
    expect(snapshot.lease).toEqual({
      holderId: 'engine-b',
      expiresAt: 5000,
      source: 'weft-workflow-lease',
    });
    expect(snapshot.lease?.epoch).toBeUndefined();
    expect(snapshot.reachability).toBe('unreachable');
    expect(snapshot.assessment).toBe('unreachable');
    expect(snapshot.evidence.some((entry) => entry.detail === health)).toBe(true);
  });

  it('carries no lease evidence at all for the sparsest contested shape (no holder record)', () => {
    const health: EngineLeaseHealth = {
      mode: 'lease',
      status: 'contested',
      holdsLease: false,
      lossReason: 'deposed',
    };
    const source = makeSource({ getLeaseHealth: () => health });
    const snapshot = projectEngineLeaseSnapshot(source, envelope());
    expect(snapshot.lease).toBeUndefined();
    expect(snapshot.assessment).toBe('unreachable');
    expect(snapshot.evidence[0]?.detail).toBe(health);
  });

  it('never calls anything that mutates lease state — getLeaseHealth is read-only', () => {
    let calls = 0;
    const source = makeSource({
      getLeaseHealth: () => {
        calls += 1;
        return { mode: 'none', status: 'disabled', holdsLease: false };
      },
    });
    projectEngineLeaseSnapshot(source, envelope());
    expect(calls).toBe(1);
  });
});

describe('projectWorkerLivenessSnapshot', () => {
  it('reports unreachable when Weft has no record for the worker (worker: null)', async () => {
    const source = makeSource({ getWorkerDiagnostics: async () => ({ worker: null }) });
    const snapshot = await projectWorkerLivenessSnapshot(source, 'worker-1', envelope());
    expect(snapshot.kind).toBe('weft-worker');
    expect(snapshot.reachability).toBe('unreachable');
    expect(snapshot.lastHeartbeatAt).toBeUndefined();
  });

  it('derives lastHeartbeatAt from heartbeatAgeMs and reports healthy for an active worker', async () => {
    const worker: WorkerDiagnosticsResult['worker'] = {
      instance: {
        workerId: 'worker-1',
        queue: 'default',
        health: 'active',
        connectedAt: 0,
        startedAt: 0,
        lastHeartbeatAt: 900,
        heartbeatAgeMs: 100,
      },
      deploymentVersion: {
        deploymentName: 'd',
        buildId: 'b',
        artifactDigest: 'a',
        runtimeName: 'bun',
        runtimeVersion: '1.4.0',
        sdkVersion: '0.23.1',
        manifestVersion: 1,
        protocolVersion: 1,
        manifestDigest: 'm',
        workflows: {},
      },
    };
    const source = makeSource({ getWorkerDiagnostics: async () => ({ worker }) });
    const snapshot = await projectWorkerLivenessSnapshot(
      source,
      'worker-1',
      envelope({ observedAt: 1_000 }),
    );
    expect(snapshot.lastHeartbeatAt).toBe(900);
    expect(snapshot.reachability).toBe('reachable');
    expect(snapshot.assessment).toBe('healthy');
    expect(snapshot.evidence).toHaveLength(1);
    expect(snapshot.evidence[0]).toMatchObject({ source: 'worker-session-heartbeat', at: 900 });
  });

  it('reports healthy/idle for a draining worker (still connected, not accepting new work)', async () => {
    const worker: WorkerDiagnosticsResult['worker'] = {
      instance: {
        workerId: 'worker-1',
        queue: 'default',
        health: 'draining',
        connectedAt: 0,
        startedAt: 0,
        lastHeartbeatAt: 900,
        heartbeatAgeMs: 100,
      },
      deploymentVersion: {
        deploymentName: 'd',
        buildId: 'b',
        artifactDigest: 'a',
        runtimeName: 'bun',
        runtimeVersion: '1.4.0',
        sdkVersion: '0.23.1',
        manifestVersion: 1,
        protocolVersion: 1,
        manifestDigest: 'm',
        workflows: {},
      },
    };
    const source = makeSource({ getWorkerDiagnostics: async () => ({ worker }) });
    const snapshot = await projectWorkerLivenessSnapshot(source, 'worker-1', envelope());
    expect(snapshot.reachability).toBe('reachable');
    expect(snapshot.progress).toBe('idle');
    expect(snapshot.assessment).toBe('healthy');
  });

  it('reports unreachable for a fully drained worker', async () => {
    const worker: WorkerDiagnosticsResult['worker'] = {
      instance: {
        workerId: 'worker-1',
        queue: 'default',
        health: 'drained',
        connectedAt: 0,
        startedAt: 0,
        lastHeartbeatAt: 500,
        heartbeatAgeMs: 500,
      },
      deploymentVersion: {
        deploymentName: 'd',
        buildId: 'b',
        artifactDigest: 'a',
        runtimeName: 'bun',
        runtimeVersion: '1.4.0',
        sdkVersion: '0.23.1',
        manifestVersion: 1,
        protocolVersion: 1,
        manifestDigest: 'm',
        workflows: {},
      },
    };
    const source = makeSource({ getWorkerDiagnostics: async () => ({ worker }) });
    const snapshot = await projectWorkerLivenessSnapshot(source, 'worker-1', envelope());
    expect(snapshot.reachability).toBe('unreachable');
    expect(snapshot.assessment).toBe('unreachable');
  });

  it('requests diagnostics for exactly the requested workerId', async () => {
    let requested: string | undefined;
    const source = makeSource({
      getWorkerDiagnostics: async (workerId) => {
        requested = workerId;
        return { worker: null };
      },
    });
    await projectWorkerLivenessSnapshot(source, 'worker-42', envelope());
    expect(requested).toBe('worker-42');
  });
});

describe('projectStreamLivenessSnapshot', () => {
  it("reuses the worker row's exact evidence and assessment, relabeled as kind 'weft-stream'", async () => {
    const worker: WorkerDiagnosticsResult['worker'] = {
      instance: {
        workerId: 'worker-1',
        queue: 'default',
        health: 'active',
        connectedAt: 0,
        startedAt: 0,
        lastHeartbeatAt: 900,
        heartbeatAgeMs: 100,
      },
      deploymentVersion: {
        deploymentName: 'd',
        buildId: 'b',
        artifactDigest: 'a',
        runtimeName: 'bun',
        runtimeVersion: '1.4.0',
        sdkVersion: '0.23.1',
        manifestVersion: 1,
        protocolVersion: 1,
        manifestDigest: 'm',
        workflows: {},
      },
    };
    const source = makeSource({ getWorkerDiagnostics: async () => ({ worker }) });
    const snapshot = await projectStreamLivenessSnapshot(source, 'worker-1', envelope());
    expect(snapshot.kind).toBe('weft-stream');
    expect(snapshot.reachability).toBe('reachable');
    expect(snapshot.assessment).toBe('healthy');
    expect(snapshot.lastHeartbeatAt).toBe(900);
  });
});

describe('projectTaskLivenessSnapshot', () => {
  const filter: TaskDiagnosticsFilter = { operationId: 'op-1' };

  it("maps a stale-inflight diagnostic to LivenessAssessment 'alive-but-stalled'", async () => {
    const source = makeSource({
      getTaskDiagnostics: async () => ({
        items: [
          {
            kind: 'stale-inflight',
            state: 'inflight',
            operationId: 'op-1',
            workflowId: undefined,
            activityName: 'sendEmail',
            queue: 'default',
            workerId: 'worker-1',
            retryCount: 0,
            requeueCount: 0,
            heartbeatAgeMs: 90_000,
            evidence: ['heartbeat 90000ms old'],
          },
        ],
        summary: {
          stuckQueued: 0,
          staleInflight: 1,
          retryStorms: 0,
          allWorkersAtCapacity: 0,
          deadLettered: 0,
          delayed: 0,
          unadoptedTerminal: 0,
        },
        limit: 50,
      }),
    });
    const snapshot = await projectTaskLivenessSnapshot(source, filter, envelope());
    expect(snapshot.kind).toBe('weft-task');
    expect(snapshot.assessment).toBe('alive-but-stalled');
    expect(snapshot.reachability).toBe('late');
    expect(snapshot.lastHeartbeatAt).toBe(envelope().observedAt - 90_000);
  });

  it('maps no matching diagnostic item to healthy (Weft reported no anomaly for this task)', async () => {
    const source = makeSource(); // default: items: []
    const snapshot = await projectTaskLivenessSnapshot(source, filter, envelope());
    expect(snapshot.assessment).toBe('healthy');
    expect(snapshot.reachability).toBe('reachable');
  });

  it('leaves a field undefined, never defaulted, when a partial getTaskDiagnostics record omits it', async () => {
    const source = makeSource({
      getTaskDiagnostics: async () => ({
        items: [
          {
            kind: 'stale-inflight',
            state: 'inflight',
            operationId: 'op-1',
            // workerId, activityName, heartbeatAgeMs, queue deliberately omitted —
            // a partial record.
            retryCount: 1,
            requeueCount: 0,
            evidence: [],
          },
        ],
        summary: {
          stuckQueued: 0,
          staleInflight: 1,
          retryStorms: 0,
          allWorkersAtCapacity: 0,
          deadLettered: 0,
          delayed: 0,
          unadoptedTerminal: 0,
        },
        limit: 50,
      }),
    });
    const snapshot = await projectTaskLivenessSnapshot(source, filter, envelope());
    // heartbeatAgeMs was absent on the returned item, so lastHeartbeatAt must
    // stay undefined — never synthesized from adjacent evidence (AC) — and no
    // 'task-attempt-heartbeat' evidence entry is fabricated for a heartbeat
    // Weft never reported either.
    expect(snapshot.lastHeartbeatAt).toBeUndefined();
    expect(snapshot.evidence.some((entry) => entry.source === 'task-attempt-heartbeat')).toBe(
      false,
    );
    expect(snapshot.assessment).toBe('alive-but-stalled');
  });

  it("maps a dead-lettered diagnostic to LivenessAssessment 'terminal'", async () => {
    const source = makeSource({
      getTaskDiagnostics: async () => ({
        items: [
          {
            kind: 'dead-lettered',
            state: 'dead-lettered',
            operationId: 'op-1',
            retryCount: 5,
            requeueCount: 0,
            evidence: [],
          },
        ],
        summary: {
          stuckQueued: 0,
          staleInflight: 0,
          retryStorms: 0,
          allWorkersAtCapacity: 0,
          deadLettered: 1,
          delayed: 0,
          unadoptedTerminal: 0,
        },
        limit: 50,
      }),
    });
    const snapshot = await projectTaskLivenessSnapshot(source, filter, envelope());
    expect(snapshot.status).toBe('terminal');
    expect(snapshot.assessment).toBe('terminal');
    expect(snapshot.reachability).toBe('not-applicable');
    expect(snapshot.progress).toBe('not-applicable');
  });

  it("maps a delayed (expected future dispatch) diagnostic to LivenessAssessment 'legitimately-waiting'", async () => {
    const source = makeSource({
      getTaskDiagnostics: async () => ({
        items: [
          {
            kind: 'delayed',
            state: 'queued',
            operationId: 'op-1',
            queue: 'default',
            retryCount: 1,
            requeueCount: 0,
            availableAt: 5_000,
            evidence: [],
          },
        ],
        summary: {
          stuckQueued: 0,
          staleInflight: 0,
          retryStorms: 0,
          allWorkersAtCapacity: 0,
          deadLettered: 0,
          delayed: 1,
          unadoptedTerminal: 0,
        },
        limit: 50,
      }),
    });
    const snapshot = await projectTaskLivenessSnapshot(source, filter, envelope());
    expect(snapshot.status).toBe('waiting');
    expect(snapshot.assessment).toBe('legitimately-waiting');
    expect(snapshot.declaredWait?.reason).toBe('queue-capacity');
  });

  it("maps a stuck-queued diagnostic to LivenessAssessment 'alive-but-stalled'", async () => {
    const source = makeSource({
      getTaskDiagnostics: async () => ({
        items: [
          {
            kind: 'stuck-queued',
            state: 'queued',
            operationId: 'op-1',
            queue: 'default',
            retryCount: 0,
            requeueCount: 0,
            queueLatencyMs: 120_000,
            evidence: [],
          },
        ],
        summary: {
          stuckQueued: 1,
          staleInflight: 0,
          retryStorms: 0,
          allWorkersAtCapacity: 0,
          deadLettered: 0,
          delayed: 0,
          unadoptedTerminal: 0,
        },
        limit: 50,
      }),
    });
    const snapshot = await projectTaskLivenessSnapshot(source, filter, envelope());
    expect(snapshot.assessment).toBe('alive-but-stalled');
  });

  it("maps an unadopted-terminal diagnostic to LivenessAssessment 'terminal'", async () => {
    const source = makeSource({
      getTaskDiagnostics: async () => ({
        items: [
          {
            kind: 'unadopted-terminal',
            state: 'resolved',
            operationId: 'op-1',
            queue: 'default',
            terminalAt: 10_000,
            adopted: false,
            evidence: [],
          },
        ],
        summary: {
          stuckQueued: 0,
          staleInflight: 0,
          retryStorms: 0,
          allWorkersAtCapacity: 0,
          deadLettered: 0,
          delayed: 0,
          unadoptedTerminal: 1,
        },
        limit: 50,
      }),
    });
    const snapshot = await projectTaskLivenessSnapshot(source, filter, envelope());
    expect(snapshot.status).toBe('terminal');
    expect(snapshot.assessment).toBe('terminal');
  });

  it("requests diagnostics filtered by exactly the requested operationId, using Weft's own default thresholds", async () => {
    let receivedInput: TaskDiagnosticsFilter | undefined;
    const source = makeSource({
      getTaskDiagnostics: async (input) => {
        receivedInput = input;
        return {
          items: [],
          summary: {
            stuckQueued: 0,
            staleInflight: 0,
            retryStorms: 0,
            allWorkersAtCapacity: 0,
            deadLettered: 0,
            delayed: 0,
            unadoptedTerminal: 0,
          },
          limit: 50,
        };
      },
    });
    await projectTaskLivenessSnapshot(source, { operationId: 'op-9' }, envelope());
    expect(receivedInput?.operationId).toBe('op-9');
  });

  it('never calls anything that mutates task/lease state — getTaskDiagnostics is read-only', async () => {
    let calls = 0;
    const source = makeSource({
      getTaskDiagnostics: async () => {
        calls += 1;
        return {
          items: [],
          summary: {
            stuckQueued: 0,
            staleInflight: 0,
            retryStorms: 0,
            allWorkersAtCapacity: 0,
            deadLettered: 0,
            delayed: 0,
            unadoptedTerminal: 0,
          },
          limit: 50,
        };
      },
    });
    await projectTaskLivenessSnapshot(source, filter, envelope());
    expect(calls).toBe(1);
  });
});

describe('buildTaskDiagnosticsInput', () => {
  it("merges the caller's filter onto Weft's own weft.tasks.diagnostics defaults", () => {
    const input = buildTaskDiagnosticsInput({ operationId: 'op-1', queue: 'default' });
    expect(input).toEqual({
      operationId: 'op-1',
      queue: 'default',
      staleQueuedAfterMs: 60_000,
      staleHeartbeatAfterMs: 60_000,
      retryStormMinimumAttempts: 3,
      includeExpectedDelayed: false,
      unadoptedAfterMs: 60_000,
      limit: 50,
    });
  });
});
