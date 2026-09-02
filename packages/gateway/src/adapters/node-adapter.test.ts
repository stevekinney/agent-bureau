import { describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';

import { createNodeAdapter, defaultLoadServe, promisifyClose } from './node-adapter';

/**
 * `promisifyClose` wraps the Node-style `close(callback)` shutdown that
 * `@hono/node-server`'s `serve()` result exposes. These tests exercise it
 * directly against a fake closeable server so the Node adapter's `stop()`
 * can be verified without spinning up a real HTTP listener.
 */
describe('promisifyClose', () => {
  it('resolves only after the callback-based close() invokes its callback', async () => {
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeCalled = false;

    const fakeServer = {
      close: (callback?: (error?: Error) => void) => {
        closeCalled = true;
        void (async () => {
          await closeGate;
          callback?.();
        })();
      },
    };

    let resolved = false;
    const stopPromise = promisifyClose(fakeServer).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(closeCalled).toBe(true);
    expect(resolved).toBe(false);

    releaseClose?.();
    await stopPromise;
    expect(resolved).toBe(true);
  });

  it('rejects when close() invokes its callback with an error', async () => {
    const failure = new Error('close failed');
    const fakeServer = {
      close: (callback?: (error?: Error) => void) => {
        callback?.(failure);
      },
    };

    let caught: unknown;
    try {
      await promisifyClose(fakeServer);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });

  it('resolves when close() invokes its callback with no arguments', async () => {
    const fakeServer = {
      close: (callback?: (error?: Error) => void) => {
        callback?.();
      },
    };

    const result = await promisifyClose(fakeServer);
    expect(result).toBeUndefined();
  });
});

/** A Hono-shaped stub — the adapter never calls anything but `fetch`. */
function fakeApp(): Hono {
  return { fetch: () => new Response('ok') } as unknown as Hono;
}

describe('createNodeAdapter — stop()', () => {
  it('does not resolve until the injected serve() result close() invokes its callback', async () => {
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeCalled = false;

    const adapter = createNodeAdapter({
      loadServe: async () => () => ({
        close: (callback?: (error?: Error) => void) => {
          closeCalled = true;
          void (async () => {
            await closeGate;
            callback?.();
          })();
        },
      }),
    });

    const handle = await adapter.serve(fakeApp(), { port: 0 });

    let resolved = false;
    const stopPromise = handle.stop().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(closeCalled).toBe(true);
    expect(resolved).toBe(false);

    releaseClose?.();
    await stopPromise;
    expect(resolved).toBe(true);
  });
});

describe('defaultLoadServe', () => {
  it('resolves to the real @hono/node-server serve() function', async () => {
    const serve = await defaultLoadServe();
    expect(typeof serve).toBe('function');
  });
});
