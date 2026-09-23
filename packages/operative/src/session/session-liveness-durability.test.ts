import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createSessionHandleFixture } from './session-handle-test-support';

// Drain Weft's deferred inline-launch queue between tests — prevents one test's
// pending macrotask from interfering with the next under bun test concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('SessionHandle liveness — durability', () => {
  it('is always process-local, even mid-run and mid-monitor', async () => {
    const { handle } = createSessionHandleFixture();
    expect(handle.snapshot().durability).toBe('process-local');

    const runPromise = handle.run('hello').result();
    expect(handle.snapshot().durability).toBe('process-local');
    await runPromise;
    expect(handle.snapshot().durability).toBe('process-local');

    await handle.monitor({ every: 5, input: 'poll', until: () => true });
    expect(handle.snapshot().durability).toBe('process-local');
  });
});
