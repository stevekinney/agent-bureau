import { describe, expect, it } from 'bun:test';

import { LoopDetector } from '../src/core/loop-detection';

describe('LoopDetector class stableStringify', () => {
  it('detects repetition with different key order (key-order independent hashing)', () => {
    const detector = new LoopDetector({ repetitionThreshold: 3, maxWindowSize: 10 });

    // Record calls with different key order but same values
    detector.recordCall('tool', { a: 1, b: 2 });
    detector.recordCall('tool', { b: 2, a: 1 });
    detector.recordCall('tool', { a: 1, b: 2 });

    const result = detector.detectLoop();
    expect(result.detected).toBe(true);
    expect(result.message).toContain('repeated loop');
  });

  it('hashes nested objects in a key-order independent manner', () => {
    const detector = new LoopDetector({ repetitionThreshold: 3, maxWindowSize: 10 });

    detector.recordCall('tool', { x: { b: 2, a: 1 }, y: 3 });
    detector.recordCall('tool', { y: 3, x: { a: 1, b: 2 } });
    detector.recordCall('tool', { x: { b: 2, a: 1 }, y: 3 });

    const result = detector.detectLoop();
    expect(result.detected).toBe(true);
  });
});

describe('LoopDetector with warningThreshold and blockThreshold', () => {
  it('returns warning level at warningThreshold', () => {
    const detector = new LoopDetector({
      warningThreshold: 3,
      blockThreshold: 6,
      maxWindowSize: 30,
    });

    for (let i = 0; i < 3; i++) {
      detector.recordCall('tool', { same: true });
    }

    const result = detector.detectLoop();
    expect(result.detected).toBe(true);
    expect(result.level).toBe('warning');
    expect(result.detector).toBe('simple-repeat');
    expect(result.count).toBeGreaterThanOrEqual(3);
  });

  it('returns blocked level at blockThreshold', () => {
    const detector = new LoopDetector({
      warningThreshold: 3,
      blockThreshold: 6,
      maxWindowSize: 30,
    });

    for (let i = 0; i < 6; i++) {
      detector.recordCall('tool', { same: true });
    }

    const result = detector.detectLoop();
    expect(result.detected).toBe(true);
    expect(result.level).toBe('blocked');
    expect(result.detector).toBe('simple-repeat');
  });

  it('detects ping-pong with warning level', () => {
    const detector = new LoopDetector({
      warningThreshold: 4,
      blockThreshold: 10,
      maxWindowSize: 30,
    });

    for (let i = 0; i < 5; i++) {
      detector.recordCall('toolA', { type: 'A' });
      detector.recordCall('toolB', { type: 'B' });
    }

    const result = detector.detectLoop();
    expect(result.detected).toBe(true);
    expect(result.level).toBeDefined();
    expect(result.detector).toBe('ping-pong');
  });

  it('returns not detected when under thresholds', () => {
    const detector = new LoopDetector({
      warningThreshold: 10,
      blockThreshold: 20,
      maxWindowSize: 30,
    });

    detector.recordCall('tool', { a: 1 });
    detector.recordCall('tool', { a: 2 });

    const result = detector.detectLoop();
    expect(result.detected).toBe(false);
  });
});
