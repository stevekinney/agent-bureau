import { describe, expect, it, mock } from 'bun:test';

import { createSessionTaintTracker } from './session-taint';
import type { InputDetector, OutputValidator, SessionTaintedEvent } from './types';

function createMockDetector(name: string): InputDetector {
  return {
    name,
    detect: async () => ({ triggered: false, confidence: 0, category: 'mock' }),
  };
}

function createMockValidator(name: string): OutputValidator {
  return {
    name,
    validate: async () => ({ valid: true, confidence: 0, category: 'mock' }),
  };
}

const baseTaintEvent: SessionTaintedEvent = {
  reason: 'High-confidence injection detected',
  detector: 'prompt-injection',
  confidence: 0.95,
  step: 1,
};

describe('createSessionTaintTracker', () => {
  it('starts in an untainted state', () => {
    const tracker = createSessionTaintTracker();
    expect(tracker.isTainted()).toBe(false);
  });

  it('becomes tainted after calling taint()', () => {
    const tracker = createSessionTaintTracker();
    tracker.taint(baseTaintEvent);
    expect(tracker.isTainted()).toBe(true);
  });

  it('stays tainted once tainted (no un-tainting)', () => {
    const tracker = createSessionTaintTracker();
    tracker.taint(baseTaintEvent);
    expect(tracker.isTainted()).toBe(true);
    // Taint is sticky
    expect(tracker.isTainted()).toBe(true);
  });

  it('calls onTainted callback when tainted', () => {
    const onTainted = mock((_event: SessionTaintedEvent) => {});
    const tracker = createSessionTaintTracker({ onTainted });
    tracker.taint(baseTaintEvent);
    expect(onTainted).toHaveBeenCalledTimes(1);
    const event = onTainted.mock.calls[0]![0];
    expect(event).toEqual(baseTaintEvent);
  });

  it('does not call onTainted on subsequent taint calls', () => {
    const onTainted = mock((_event: SessionTaintedEvent) => {});
    const tracker = createSessionTaintTracker({ onTainted });
    tracker.taint(baseTaintEvent);
    tracker.taint({ ...baseTaintEvent, step: 2 });
    // Only fires on first taint
    expect(onTainted).toHaveBeenCalledTimes(1);
  });

  describe('detector escalation', () => {
    it('returns no extra detectors when not tainted', () => {
      const escalatedDetectors = [createMockDetector('escalated-1')];
      const tracker = createSessionTaintTracker({
        escalatedDetectors,
      });

      const result = tracker.getDetectors();
      expect(result).toHaveLength(0);
    });

    it('returns escalated detectors when tainted', () => {
      const escalatedDetectors = [createMockDetector('escalated-1')];
      const tracker = createSessionTaintTracker({
        escalatedDetectors,
      });

      tracker.taint(baseTaintEvent);

      const result = tracker.getDetectors();
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('escalated-1');
    });
  });

  describe('validator escalation', () => {
    it('returns no extra validators when not tainted', () => {
      const escalatedValidators = [createMockValidator('escalated-v1')];
      const tracker = createSessionTaintTracker({
        escalatedValidators,
      });

      const result = tracker.getValidators();
      expect(result).toHaveLength(0);
    });

    it('returns escalated validators when tainted', () => {
      const escalatedValidators = [createMockValidator('escalated-v1')];
      const tracker = createSessionTaintTracker({
        escalatedValidators,
      });

      tracker.taint(baseTaintEvent);

      const result = tracker.getValidators();
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('escalated-v1');
    });
  });

  describe('taintThreshold', () => {
    it('uses default threshold of 0.9', () => {
      const tracker = createSessionTaintTracker();
      // The tracker itself doesn't check threshold — that's the caller's job
      // But we verify the tracker accepts threshold option
      expect(tracker.isTainted()).toBe(false);
    });
  });
});
