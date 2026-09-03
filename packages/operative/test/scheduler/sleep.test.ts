import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import { sleep } from '../../src/scheduler/sleep';

describe('sleep', () => {
  it('resolves once the manual runtime advances past the requested delay', async () => {
    const runtime = createManualRuntimeServices();
    let resolved = false;

    const pending = sleep(10, runtime.timers).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    await runtime.advance(9);
    expect(resolved).toBe(false);
    await runtime.advance(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it('resolves a zero millisecond sleep on the first advance', async () => {
    const runtime = createManualRuntimeServices();
    let resolved = false;

    const pending = sleep(0, runtime.timers).then(() => {
      resolved = true;
    });

    await runtime.advance(0);
    await pending;
    expect(resolved).toBe(true);
  });

  it('falls back to the default runtime timers when none is supplied', async () => {
    await sleep(0);
  });
});
