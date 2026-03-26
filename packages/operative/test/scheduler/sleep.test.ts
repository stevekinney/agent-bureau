import { describe, expect, it } from 'bun:test';

import { sleep } from '../../src/scheduler/sleep';

describe('sleep', () => {
  it('resolves after approximately the specified duration', async () => {
    const start = performance.now();
    await sleep(10);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(9); // Small tolerance for timer precision
  });

  it('resolves on the next tick when given 0', async () => {
    const start = performance.now();
    await sleep(0);
    const elapsed = performance.now() - start;

    // Should resolve nearly immediately (within a few ms)
    expect(elapsed).toBeLessThan(50);
  });
});
