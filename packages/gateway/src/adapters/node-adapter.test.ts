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

describe('createNodeAdapter — port discovery (AB-272)', () => {
  it('reports the real bound port from address() immediately when already listening', async () => {
    const adapter = createNodeAdapter({
      loadServe: async () => () => ({
        close: (callback?: (error?: Error) => void) => callback?.(),
        // Already bound by the time serve() returns — waitForListening's
        // fast path (no wait for a 'listening' event that already fired).
        address: () => ({ port: 54321 }),
      }),
    });

    const handle = await adapter.serve(fakeApp(), { port: 0 });
    expect(handle.port).toBe(54321);
  });

  it('waits for the listening event before reporting the port when address() starts null', async () => {
    let listeningCallback: (() => void) | undefined;
    let bound = false;

    const adapter = createNodeAdapter({
      loadServe: async () => () => ({
        close: (callback?: (error?: Error) => void) => callback?.(),
        once: (event, listener) => {
          if (event === 'listening') listeningCallback = listener;
        },
        address: () => (bound ? { port: 9876 } : null),
      }),
    });

    const servePromise = adapter.serve(fakeApp(), { port: 0 });

    // Give serve() a turn to reach and start waiting on waitForListening()
    // before the fake server "binds" — proves it genuinely waits rather
    // than returning early with a stale/undefined port.
    await Promise.resolve();
    await Promise.resolve();
    bound = true;
    listeningCallback?.();

    const handle = await servePromise;
    expect(handle.port).toBe(9876);
  });

  it('falls back to the requested port when the injected server exposes no address()', async () => {
    const adapter = createNodeAdapter({
      loadServe: async () => () => ({
        close: (callback?: (error?: Error) => void) => callback?.(),
      }),
    });

    const handle = await adapter.serve(fakeApp(), { port: 4242 });
    expect(handle.port).toBe(4242);
  });
});

describe('createNodeAdapter — forceClose()', () => {
  it('calls closeAllConnections() when the underlying server implements it (AB-235)', async () => {
    let closeAllConnectionsCalled = false;
    const adapter = createNodeAdapter({
      loadServe: async () => () => ({
        close: (callback?: (error?: Error) => void) => {
          callback?.();
        },
        closeAllConnections: () => {
          closeAllConnectionsCalled = true;
        },
      }),
    });

    const handle = await adapter.serve(fakeApp(), { port: 0 });
    handle.forceClose();
    expect(closeAllConnectionsCalled).toBe(true);
  });

  it('is a no-op when the underlying server does not implement closeAllConnections() (AB-235)', async () => {
    const adapter = createNodeAdapter({
      loadServe: async () => () => ({
        close: (callback?: (error?: Error) => void) => {
          callback?.();
        },
        // No closeAllConnections — simulates an older Node runtime or a
        // fake test server. forceClose() must not throw.
      }),
    });

    const handle = await adapter.serve(fakeApp(), { port: 0 });
    expect(() => handle.forceClose()).not.toThrow();
  });

  it("forceClose() causes the pending stop() to resolve via close()'s callback (AB-235)", async () => {
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    const adapter = createNodeAdapter({
      loadServe: async () => () => ({
        close: (callback?: (error?: Error) => void) => {
          void (async () => {
            await closeGate;
            callback?.();
          })();
        },
        closeAllConnections: () => {
          // Simulates Node destroying open sockets, which causes the
          // pending close(callback) above to fire.
          releaseClose?.();
        },
      }),
    });

    const handle = await adapter.serve(fakeApp(), { port: 0 });

    let resolved = false;
    const stopPromise = handle.stop().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    handle.forceClose();
    await stopPromise;
    expect(resolved).toBe(true);
  });

  it('destroys tracked sockets when closeAllConnections() is unavailable (Node < 18.2, AB-235)', async () => {
    let connectionListener: ((socket: { destroy(): void; once(): unknown }) => void) | undefined;
    let socketDestroyed = false;

    const adapter = createNodeAdapter({
      loadServe: async () => () => ({
        close: (callback?: (error?: Error) => void) => {
          callback?.();
        },
        // No closeAllConnections — simulates Node 18.0/18.1, which the
        // repository's `node >=18` engine range still permits.
        on: (
          event: 'connection',
          listener: (socket: { destroy(): void; once(): unknown }) => void,
        ) => {
          if (event === 'connection') connectionListener = listener;
        },
      }),
    });

    const handle = await adapter.serve(fakeApp(), { port: 0 });

    // Simulate one inbound TCP connection the adapter tracked via 'connection'.
    connectionListener?.({
      destroy: () => {
        socketDestroyed = true;
      },
      once: () => undefined,
    });

    handle.forceClose();
    expect(socketDestroyed).toBe(true);
  });

  it('stops tracking a socket once it closes on its own, so a later forceClose() does not touch it', async () => {
    let connectionListener:
      | ((socket: { destroy(): void; once(event: 'close', listener: () => void): unknown }) => void)
      | undefined;
    let closeListener: (() => void) | undefined;
    let destroyCalls = 0;

    const adapter = createNodeAdapter({
      loadServe: async () => () => ({
        close: (callback?: (error?: Error) => void) => {
          callback?.();
        },
        on: (
          event: 'connection',
          listener: (socket: {
            destroy(): void;
            once(event: 'close', listener: () => void): unknown;
          }) => void,
        ) => {
          if (event === 'connection') connectionListener = listener;
        },
      }),
    });

    const handle = await adapter.serve(fakeApp(), { port: 0 });

    connectionListener?.({
      destroy: () => {
        destroyCalls++;
      },
      once: (event, listener) => {
        if (event === 'close') closeListener = listener;
      },
    });

    // The connection closes on its own (e.g. a normal request finishing)
    // before shutdown ever calls forceClose().
    closeListener?.();

    handle.forceClose();
    expect(destroyCalls).toBe(0);
  });
});
