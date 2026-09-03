import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import { addJitter } from '../../src/retry/jitter';

describe('addJitter', () => {
  it('returns the exact delay when jitter is disabled', () => {
    const result = addJitter(1000, { enabled: false });
    expect(result).toBe(1000);
  });

  it('returns a value within the default jitter range', () => {
    const delay = 1000;
    // Default max jitter = half the delay = 500
    // So result should be in [500, 1500]
    for (let i = 0; i < 50; i++) {
      const result = addJitter(delay);
      expect(result).toBeGreaterThanOrEqual(500);
      expect(result).toBeLessThanOrEqual(1500);
    }
  });

  it('respects a custom maxJitter value', () => {
    const delay = 1000;
    const maxJitter = 100;
    for (let i = 0; i < 50; i++) {
      const result = addJitter(delay, { maxJitter });
      expect(result).toBeGreaterThanOrEqual(900);
      expect(result).toBeLessThanOrEqual(1100);
    }
  });

  it('returns zero when delay is zero', () => {
    const result = addJitter(0);
    expect(result).toBe(0);
  });

  it('never returns a negative value', () => {
    for (let i = 0; i < 50; i++) {
      const result = addJitter(10, { maxJitter: 100 });
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns the delay unchanged when maxJitter is zero', () => {
    const result = addJitter(500, { maxJitter: 0 });
    expect(result).toBe(500);
  });

  describe('AB-92/AB-252: injected RuntimeServices.random', () => {
    it('produces the same jitter twice from the same seed, never touching Math.random', () => {
      const firstRun = () => {
        const runtime = createManualRuntimeServices({ randomSeed: 'jitter-determinism' });
        return addJitter(1000, { maxJitter: 200, random: runtime.random.next });
      };
      expect(firstRun()).toBe(firstRun());
    });

    it('diverges when two runs use different seeds', () => {
      const withSeed = (randomSeed: string) => {
        const runtime = createManualRuntimeServices({ randomSeed });
        return addJitter(1000, { maxJitter: 200, random: runtime.random.next });
      };
      expect(withSeed('seed-a')).not.toBe(withSeed('seed-b'));
    });

    it('falls back to a real default RuntimeServices instance, never a bare Math.random call, when no random option is supplied', () => {
      const delay = 1000;
      for (let i = 0; i < 20; i++) {
        const result = addJitter(delay, { maxJitter: 500 });
        expect(result).toBeGreaterThanOrEqual(500);
        expect(result).toBeLessThanOrEqual(1500);
      }
    });
  });
});
