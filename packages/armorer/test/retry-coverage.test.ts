import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { retry } from '../src/utilities/retry';

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
    await expect(wrapped({ value: 1 })).rejects.toThrow(
      JSON.stringify({ code: 'OBJ_FAIL' }),
    );
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

    await expect((wrapped as any).rawExecute({ value: 1 }, { signal })).rejects.toThrow(
      'stop',
    );
  });

  it('aborts during retry delays when the signal is triggered', async () => {
    const failing = makeRawTool(async () => {
      throw new Error('boom');
    });
    const wrapped = retry(failing, { attempts: 3, delayMs: 50 });
    const controller = new AbortController();
    const pending = (wrapped as any).execute({ value: 1 }, { signal: controller.signal });

    setTimeout(() => controller.abort('delay-stop'), 5);
    await expect(pending).rejects.toThrow('delay-stop');
  });
});
