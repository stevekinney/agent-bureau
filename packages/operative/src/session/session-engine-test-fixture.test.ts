import { describe, expect, it } from 'bun:test';

import { createSessionEngine } from './session-engine-test-fixture';

describe('session engine test fixture', () => {
  it('keeps recovery result callbacks lazy and preserves their returned promise', async () => {
    let resultCalls = 0;
    const result = Promise.resolve('recovered');
    const engine = createSessionEngine({
      resume: async () => ({
        id: 'lazy-recovery',
        result: () => {
          resultCalls += 1;
          return result;
        },
      }),
    });

    const handle = await engine.resume('lazy-recovery');
    expect(resultCalls).toBe(0);
    expect(await handle.result()).toBe('recovered');
    expect(resultCalls).toBe(1);
    expect(await handle.result()).toBe('recovered');
    expect(resultCalls).toBe(2);
  });
});
