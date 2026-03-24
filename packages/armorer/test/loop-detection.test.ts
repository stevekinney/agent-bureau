import { describe, expect, it } from 'bun:test';

import { LoopDetector, stableStringify } from '../src/core/loop-detection';

describe('loop detection', () => {
  describe('stableStringify', () => {
    it('is key-order independent', () => {
      expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
    });
    it('handles null and undefined', () => {
      expect(stableStringify(null)).toBe('null');
      expect(stableStringify(undefined)).toBe(undefined); // JSON.stringify(undefined) returns undefined
    });
    it('handles primitives', () => {
      expect(stableStringify(42)).toBe('42');
      expect(stableStringify('hello')).toBe('"hello"');
      expect(stableStringify(true)).toBe('true');
    });
    it('handles arrays', () => {
      expect(stableStringify([1, 2, 3])).toBe('[1,2,3]');
    });
    it('handles nested objects', () => {
      const a = stableStringify({ x: { b: 2, a: 1 }, y: [3, 4] });
      const b = stableStringify({ y: [3, 4], x: { a: 1, b: 2 } });
      expect(a).toBe(b);
    });
  });

  describe('LoopDetector recordCall', () => {
    it('appends to call window', () => {
      const detector = new LoopDetector({ maxWindowSize: 30 });
      detector.recordCall('tool', { a: 1 });
      const stats = detector.getLoopStatistics();
      expect(stats.callCount).toBe(1);
    });
    it('trims to window size', () => {
      const detector = new LoopDetector({ maxWindowSize: 30, repetitionThreshold: 100 });
      for (let i = 0; i < 40; i++) {
        detector.recordCall('tool', { i });
      }
      const stats = detector.getLoopStatistics();
      expect(Object.keys(stats.hashCounts).length).toBeLessThanOrEqual(30);
    });
  });

  describe('LoopDetector detectLoop (level mode)', () => {
    it('returns detected false for empty history', () => {
      const detector = new LoopDetector({ warningThreshold: 10, blockThreshold: 20 });
      const result = detector.detectLoop();
      expect(result.detected).toBe(false);
    });

    it('returns detected false for unique calls', () => {
      const detector = new LoopDetector({ warningThreshold: 10, blockThreshold: 20 });
      for (let i = 0; i < 5; i++) {
        detector.recordCall('tool', { i });
      }
      const result = detector.detectLoop();
      expect(result.detected).toBe(false);
    });

    it('returns warning at warningThreshold', () => {
      const detector = new LoopDetector({
        warningThreshold: 10,
        blockThreshold: 20,
        maxWindowSize: 30,
      });
      for (let i = 0; i < 10; i++) {
        detector.recordCall('tool', { same: true });
      }
      const result = detector.detectLoop();
      expect(result.detected).toBe(true);
      expect(result.level).toBe('warning');
      expect(result.detector).toBe('simple-repeat');
      expect(result.count).toBe(10);
    });

    it('returns blocked at blockThreshold', () => {
      const detector = new LoopDetector({
        warningThreshold: 10,
        blockThreshold: 20,
        maxWindowSize: 30,
      });
      for (let i = 0; i < 20; i++) {
        detector.recordCall('tool', { same: true });
      }
      const result = detector.detectLoop();
      expect(result.detected).toBe(true);
      expect(result.level).toBe('blocked');
      expect(result.detector).toBe('simple-repeat');
      expect(result.count).toBe(20);
    });

    it('uses custom thresholds', () => {
      const detector = new LoopDetector({
        warningThreshold: 3,
        blockThreshold: 5,
        maxWindowSize: 30,
      });
      for (let i = 0; i < 3; i++) {
        detector.recordCall('tool', {});
      }
      const result = detector.detectLoop();
      expect(result.detected).toBe(true);
      expect(result.level).toBe('warning');
    });

    it('detects ping-pong pattern', () => {
      const detector = new LoopDetector({
        warningThreshold: 10,
        blockThreshold: 20,
        maxWindowSize: 30,
      });
      for (let i = 0; i < 10; i++) {
        if (i % 2 === 0) {
          detector.recordCall('toolA', { type: 'A' });
        } else {
          detector.recordCall('toolB', { type: 'B' });
        }
      }
      const result = detector.detectLoop();
      expect(result.detected).toBe(true);
      expect(result.detector).toBe('ping-pong');
    });

    it('handles null/undefined args', () => {
      const detector = new LoopDetector({ warningThreshold: 10, blockThreshold: 20 });
      detector.recordCall('tool', null);
      detector.recordCall('tool', undefined);
      const result = detector.detectLoop();
      expect(result.detected).toBe(false);
    });
  });

  describe('LoopDetector getLoopStatistics', () => {
    it('returns empty stats for no history', () => {
      const detector = new LoopDetector();
      const stats = detector.getLoopStatistics();
      expect(stats.callCount).toBe(0);
    });

    it('returns accurate counts', () => {
      const detector = new LoopDetector({ maxWindowSize: 30 });
      detector.recordCall('toolA', { x: 1 });
      detector.recordCall('toolA', { x: 1 });
      detector.recordCall('toolA', { x: 1 });
      detector.recordCall('toolB', { y: 2 });
      const stats = detector.getLoopStatistics();
      expect(stats.callCount).toBe(4);
    });
  });
});
