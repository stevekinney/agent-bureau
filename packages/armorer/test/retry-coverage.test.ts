import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';
import { z } from 'zod';

import { internalRetryTestUtilities, retry } from '../src/utilities/retry';

describe('retry coverage edges', () => {
  const makeRawTool = (execute: (input: unknown) => Promise<unknown>) => {
    const rawTool = async (input: unknown) => execute(input);
    rawTool.description = 'raw tool';
    rawTool.schema = z.object({ value: z.number() });
    rawTool.tags = ['raw'];
    rawTool.metadata = { tier: 'test' };
    return rawTool;
  };

  it('throws immediately when shouldRetry returns false', async () => {
    let attempts = 0;
    let shouldRetryCalls = 0;
    const failing = makeRawTool(async () => {
      attempts += 1;
      throw 'stop';
    });

    const wrapped = retry(failing, {
      attempts: 2,
      shouldRetry: async () => {
        shouldRetryCalls += 1;
        return false;
      },
    });

    await expect(wrapped({ value: 1 })).rejects.toThrow('stop');
    expect(attempts).toBe(1);
    expect(shouldRetryCalls).toBe(1);
  });

  it('normalizes string errors when attempts are exhausted', async () => {
    const failing = makeRawTool(async () => {
      throw 'nope';
    });

    const wrapped = retry(failing, { attempts: 1 });
    await expect(wrapped({ value: 1 })).rejects.toThrow('nope');
  });

  it('stringifies thrown objects when attempts are exhausted', async () => {
    const failing = makeRawTool(async () => {
      throw { code: 'OBJ_FAIL' };
    });

    const wrapped = retry(failing, { attempts: 1 });
    await expect(wrapped({ value: 1 })).rejects.toThrow(JSON.stringify({ code: 'OBJ_FAIL' }));
  });

  it('falls back when thrown objects are not serializable', async () => {
    const circular: any = { code: 'CYCLE' };
    circular.self = circular;
    const failing = makeRawTool(async () => {
      throw circular;
    });

    const wrapped = retry(failing, { attempts: 1 });
    await expect(wrapped({ value: 1 })).rejects.toThrow('[object Object]');
  });

  it('throws when the signal is already aborted', async () => {
    const failing = makeRawTool(async () => {
      throw new Error('boom');
    });
    const wrapped = retry(failing, { attempts: 2 });
    const controller = new AbortController();
    controller.abort('cancelled');

    await expect(
      (wrapped as any).execute(
        { value: 1 },
        {
          signal: controller.signal,
          timeout: 10,
        },
      ),
    ).rejects.toThrow('cancelled');
  });

  it('aborts after a failed attempt when the signal is triggered', async () => {
    const failing = makeRawTool(async () => {
      throw new Error('boom');
    });
    const wrapped = retry(failing, { attempts: 2 });

    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks > 1;
      },
      reason: 'stop',
    };

    await expect((wrapped as any).rawExecute({ value: 1 }, { signal })).rejects.toThrow('stop');
  });

  it('aborts during retry delays when the signal is triggered', async () => {
    const failing = makeRawTool(async () => {
      throw new Error('boom');
    });
    const controller = new AbortController();
    const wrapped = retry(failing, {
      attempts: 3,
      delayMs: 50,
      async sleep(milliseconds, signal) {
        expect(milliseconds).toBe(50);
        controller.abort('delay-stop');
        if (signal?.aborted) {
          throw new Error(String(signal.reason));
        }
      },
    });

    await expect(
      (wrapped as any).execute({ value: 1 }, { signal: controller.signal }),
    ).rejects.toThrow('delay-stop');
  });

  it('uses the default delay before a successful retry', async () => {
    let attempts = 0;
    const flaky = makeRawTool(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('retry once');
      return 'ok';
    });
    const wrapped = retry(flaky, { attempts: 2, delayMs: 1 });

    await expect(wrapped({ value: 1 })).resolves.toBe('ok');
    expect(attempts).toBe(2);
  });

  it('supports the retry wait helper without a cancellation signal', async () => {
    await expect(internalRetryTestUtilities.wait(0)).resolves.toBeUndefined();
  });

  describe('AB-92/AB-254: RuntimeServices composition', () => {
    it('drives exponential backoff entirely through ManualRuntimeServices.advance, with no real timer', async () => {
      const runtime = createManualRuntimeServices();
      let attempts = 0;
      const failing = makeRawTool(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error(`attempt ${attempts} failed`);
        return 'ok';
      });

      const wrapped = retry(failing, {
        attempts: 3,
        delayMs: 100,
        backoff: 'exponential',
        runtime,
      });

      const resultPromise = wrapped({ value: 1 });

      // First failure schedules a 100ms delay before attempt 2.
      while (runtime.pendingTimers().length === 0) {
        await Promise.resolve();
      }
      expect(attempts).toBe(1);
      await runtime.advance(100);
      while (attempts < 2) {
        await Promise.resolve();
      }

      // Second failure schedules the exponential-backoff 200ms delay before
      // attempt 3.
      while (runtime.pendingTimers().length === 0) {
        await Promise.resolve();
      }
      await runtime.advance(200);

      await expect(resultPromise).resolves.toBe('ok');
      expect(attempts).toBe(3);
    });

    it('resolves its own default RuntimeServices when none is supplied, unaffected in production behavior', async () => {
      const flaky = makeRawTool(async () => 'ok');
      const wrapped = retry(flaky, { attempts: 1 });
      await expect(wrapped({ value: 1 })).resolves.toBe('ok');
    });
  });
});
