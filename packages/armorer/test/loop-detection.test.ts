import { describe, expect, it } from 'bun:test';
import {
  createLoopDetectionState,
  detectLoop,
  getLoopStatistics,
  hashToolCall,
  recordCall,
  stableStringify,
} from '../src/loop-detection/index';

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

  describe('hashToolCall', () => {
    it('is deterministic', () => {
      expect(hashToolCall('tool', { a: 1 })).toBe(hashToolCall('tool', { a: 1 }));
    });
    it('differs for different input', () => {
      expect(hashToolCall('tool', { a: 1 })).not.toBe(hashToolCall('tool', { a: 2 }));
    });
    it('is key-order independent', () => {
      expect(hashToolCall('tool', { a: 1, b: 2 })).toBe(hashToolCall('tool', { b: 2, a: 1 }));
    });
    it('differs for different tool names', () => {
      expect(hashToolCall('toolA', { a: 1 })).not.toBe(hashToolCall('toolB', { a: 1 }));
    });
  });

  describe('recordCall', () => {
    it('appends to history', () => {
      const state = createLoopDetectionState();
      recordCall(state, 'tool', { a: 1 });
      expect(state.history).toHaveLength(1);
    });
    it('trims to window size', () => {
      const state = createLoopDetectionState();
      for (let i = 0; i < 40; i++) {
        recordCall(state, 'tool', { i }, { windowSize: 30 });
      }
      expect(state.history).toHaveLength(30);
    });
    it('uses default window size of 30', () => {
      const state = createLoopDetectionState();
      for (let i = 0; i < 35; i++) {
        recordCall(state, 'tool', { i });
      }
      expect(state.history).toHaveLength(30);
    });
  });

  describe('detectLoop', () => {
    it('returns detected false for empty history', () => {
      const state = createLoopDetectionState();
      expect(detectLoop(state, 'tool', {})).toEqual({ detected: false });
    });

    it('returns detected false for unique calls', () => {
      const state = createLoopDetectionState();
      for (let i = 0; i < 5; i++) {
        recordCall(state, 'tool', { i });
      }
      expect(detectLoop(state, 'tool', { i: 99 })).toEqual({ detected: false });
    });

    it('returns warning at default threshold (10)', () => {
      const state = createLoopDetectionState();
      for (let i = 0; i < 10; i++) {
        recordCall(state, 'tool', { same: true });
      }
      const result = detectLoop(state, 'tool', { same: true });
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.level).toBe('warning');
        expect(result.detector).toBe('simple-repeat');
        expect(result.count).toBe(10);
      }
    });

    it('returns blocked at default threshold (20)', () => {
      const state = createLoopDetectionState();
      for (let i = 0; i < 20; i++) {
        recordCall(state, 'tool', { same: true });
      }
      const result = detectLoop(state, 'tool', { same: true });
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.level).toBe('blocked');
        expect(result.detector).toBe('simple-repeat');
        expect(result.count).toBe(20);
      }
    });

    it('uses custom thresholds', () => {
      const state = createLoopDetectionState();
      for (let i = 0; i < 3; i++) {
        recordCall(state, 'tool', {});
      }
      const result = detectLoop(state, 'tool', {}, { warningThreshold: 3, blockThreshold: 5 });
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.level).toBe('warning');
      }
    });

    it('detects ping-pong pattern', () => {
      const state = createLoopDetectionState();
      for (let i = 0; i < 10; i++) {
        if (i % 2 === 0) {
          recordCall(state, 'toolA', { type: 'A' });
        } else {
          recordCall(state, 'toolB', { type: 'B' });
        }
      }
      const result = detectLoop(state, 'toolA', { type: 'A' }, { warningThreshold: 10, blockThreshold: 20 });
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.detector).toBe('ping-pong');
      }
    });

    it('detects ping-pong blocked pattern', () => {
      const state = createLoopDetectionState();
      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
          recordCall(state, 'toolA', { type: 'A' });
        } else {
          recordCall(state, 'toolB', { type: 'B' });
        }
      }
      // Set warningThreshold high enough that simple-repeat (count=10) won't trigger,
      // but ping-pong (alternatingCount=20) will hit blockThreshold
      const result = detectLoop(state, 'toolA', { type: 'A' }, { warningThreshold: 11, blockThreshold: 20 });
      expect(result.detected).toBe(true);
      if (result.detected) {
        expect(result.level).toBe('blocked');
        expect(result.detector).toBe('ping-pong');
        expect(result.count).toBeGreaterThanOrEqual(20);
      }
    });

    it('does not detect ping-pong when pattern breaks', () => {
      const state = createLoopDetectionState();
      recordCall(state, 'toolA', {});
      recordCall(state, 'toolB', {});
      recordCall(state, 'toolA', {});
      recordCall(state, 'toolC', {}); // break
      recordCall(state, 'toolA', {});
      recordCall(state, 'toolB', {});
      const result = detectLoop(state, 'toolA', {}, { warningThreshold: 5, blockThreshold: 10 });
      expect(result.detected).toBe(false);
    });

    it('handles null/undefined args', () => {
      const state = createLoopDetectionState();
      recordCall(state, 'tool', null);
      recordCall(state, 'tool', undefined);
      expect(detectLoop(state, 'tool', null)).toEqual({ detected: false });
    });
  });

  describe('getLoopStatistics', () => {
    it('returns empty stats for no history', () => {
      const state = createLoopDetectionState();
      const stats = getLoopStatistics(state);
      expect(stats.totalCalls).toBe(0);
      expect(stats.uniquePatterns).toBe(0);
      expect(stats.mostFrequent).toBeNull();
    });

    it('returns accurate counts', () => {
      const state = createLoopDetectionState();
      recordCall(state, 'toolA', { x: 1 });
      recordCall(state, 'toolA', { x: 1 });
      recordCall(state, 'toolA', { x: 1 });
      recordCall(state, 'toolB', { y: 2 });
      const stats = getLoopStatistics(state);
      expect(stats.totalCalls).toBe(4);
      expect(stats.uniquePatterns).toBe(2);
      expect(stats.mostFrequent?.count).toBe(3);
    });
  });
});
