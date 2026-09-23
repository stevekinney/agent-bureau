import type { ActiveRun, LivenessEvidenceEntry, SemanticProgress } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { serializeRunDetail } from './serialization';
import { buildStubLivenessSnapshot, makeRunState } from './serialization-test-helpers';

describe('run detail liveness serialization', () => {
  it('preserves every snapshot field while converting all unknown leaves', () => {
    const snapshot: ReturnType<ActiveRun['snapshot']> = {
      ...buildStubLivenessSnapshot(),
      owner: 'principal',
      parentId: 'parent',
      status: 'waiting',
      emittedAt: 10,
      lastActivityAt: 11,
      lastHeartbeatAt: 12,
      lastProgressAt: 13,
      expectedNextObservationAt: 14,
      deadline: 20,
      worstChildAssessment: 'unreachable',
      result: new Map([['attempt', 2n]]),
      semanticProgress: {
        phase: 'loading',
        current: 2,
        total: 3,
        unit: 'rows',
        message: 'reading',
        checkpoint: new Set(['a', 'b']),
      },
      declaredWait: {
        reason: 'signal',
        startedAt: 1,
        owner: 'wait-owner',
        dependency: 'dependency',
        wakeCondition: 'signal arrives',
      },
      lease: { holderId: 'holder', expiresAt: 20, epoch: 3, source: 'weft-workflow-lease' },
      evidence: [{ source: 'tool-progress', at: 1, attempt: 0, detail: new Date(0) }],
    };
    const serialized = serializeRunDetail(makeRunState(snapshot)).liveness;

    expect(serialized).toEqual({
      ...snapshot,
      result: [['attempt', '2']],
      semanticProgress: { ...snapshot.semanticProgress, checkpoint: ['a', 'b'] },
      evidence: [{ source: 'tool-progress', at: 1, attempt: 0, detail: new Date(0).toISOString() }],
    });
    expect(Object.keys(serialized)).toEqual(Object.keys(snapshot));
    expect(serialized).not.toBe(snapshot);
    expect(serialized.declaredWait).not.toBe(snapshot.declaredWait);
    expect(serialized.lease).not.toBe(snapshot.lease);
    expect(serialized.semanticProgress).not.toBe(snapshot.semanticProgress);
    expect(serialized.evidence[0]).not.toBe(snapshot.evidence[0]);
    expect(snapshot.result).toBeInstanceOf(Map);
    expect(snapshot.semanticProgress?.checkpoint).toBeInstanceOf(Set);
    expect(snapshot.evidence[0]?.detail).toBeInstanceOf(Date);
  });

  it('marks references to each active snapshot ancestor as circular', () => {
    const progress: SemanticProgress = { checkpoint: undefined };
    const entry: LivenessEvidenceEntry = {
      source: 'tool-progress',
      at: 1,
      attempt: 0,
      detail: undefined,
    };
    const evidence = [entry];
    const snapshot: ReturnType<ActiveRun['snapshot']> = {
      ...buildStubLivenessSnapshot(),
      semanticProgress: progress,
      evidence,
    };
    Object.defineProperty(snapshot, 'result', { value: snapshot, enumerable: true });
    Object.defineProperty(progress, 'checkpoint', {
      value: { snapshot, progress },
      enumerable: true,
    });
    Object.defineProperty(entry, 'detail', {
      value: { snapshot, evidence, entry },
      enumerable: true,
    });

    const serialized = serializeRunDetail(makeRunState(snapshot)).liveness;

    expect(serialized.result).toBe('[Circular]');
    expect(serialized.semanticProgress?.checkpoint).toEqual({
      snapshot: '[Circular]',
      progress: '[Circular]',
    });
    expect(serialized.evidence[0]?.detail).toEqual({
      snapshot: '[Circular]',
      evidence: '[Circular]',
      entry: '[Circular]',
    });
  });

  it('serializes repeated references in separate branches independently', () => {
    const shared = { attempts: 2n };
    const snapshot: ReturnType<ActiveRun['snapshot']> = {
      ...buildStubLivenessSnapshot(),
      result: shared,
      semanticProgress: { checkpoint: shared },
      evidence: [{ source: 'tool-progress', at: 1, attempt: 0, detail: shared }],
    };
    const serialized = serializeRunDetail(makeRunState(snapshot)).liveness;

    expect(serialized.result).toEqual({ attempts: '2' });
    expect(serialized.semanticProgress?.checkpoint).toEqual({ attempts: '2' });
    expect(serialized.evidence[0]?.detail).toEqual({ attempts: '2' });
    expect(serialized.result).not.toBe(serialized.semanticProgress?.checkpoint);
  });

  it('preserves absent properties and explicitly undefined optional properties', () => {
    const absent = serializeRunDetail(makeRunState(buildStubLivenessSnapshot())).liveness;
    const present = serializeRunDetail(
      makeRunState({
        ...buildStubLivenessSnapshot(),
        result: undefined,
        semanticProgress: undefined,
        declaredWait: undefined,
        lease: undefined,
        evidence: [{ source: 'tool-progress', at: 1, attempt: 0, detail: undefined }],
      }),
    ).liveness;

    expect(Object.hasOwn(absent, 'result')).toBe(false);
    expect(Object.hasOwn(absent, 'semanticProgress')).toBe(false);
    expect(Object.hasOwn(absent, 'declaredWait')).toBe(false);
    expect(Object.hasOwn(absent, 'lease')).toBe(false);
    expect(Object.hasOwn(present, 'result')).toBe(true);
    expect(Object.hasOwn(present, 'semanticProgress')).toBe(true);
    expect(Object.hasOwn(present, 'declaredWait')).toBe(true);
    expect(Object.hasOwn(present, 'lease')).toBe(true);
    expect(Object.hasOwn(present.evidence[0]!, 'detail')).toBe(true);
  });
});
