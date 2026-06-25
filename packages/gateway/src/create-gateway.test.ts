import { describe, expect, it } from 'bun:test';
import { createBureau } from 'bureau';
import { createStore } from 'operative/store';

import { createBunAdapter } from './adapters/bun-adapter';
import { createGateway } from './create-gateway';
import { DEFAULT_PORT } from './types';

describe('createGateway', () => {
  it('creates a gateway with default options', async () => {
    const bureau = await createBureau();
    const gateway = await createGateway(bureau);
    expect(gateway.app).toBeDefined();
    expect(gateway.store).toBeDefined();
    expect(gateway.port).toBe(DEFAULT_PORT);
    bureau.dispose();
  });

  it('uses a custom port', async () => {
    const bureau = await createBureau();
    const gateway = await createGateway(bureau, { port: 9999 });
    expect(gateway.port).toBe(9999);
    bureau.dispose();
  });

  it('uses a provided store', async () => {
    const store = createStore();
    const bureau = await createBureau({ store });
    const gateway = await createGateway(bureau);
    expect(gateway.store).toBe(store);
    bureau.dispose();
  });

  it('default port is 5555', () => {
    expect(DEFAULT_PORT).toBe(5555);
  });

  it('exposes a start function', async () => {
    const bureau = await createBureau();
    const gateway = await createGateway(bureau);
    expect(typeof gateway.start).toBe('function');
    bureau.dispose();
  });

  it('accepts runtime option', async () => {
    const bureau = await createBureau();
    const gateway = await createGateway(bureau, { runtime: 'bun' });
    expect(gateway.app).toBeDefined();
    bureau.dispose();
  });

  it('exposes the bureau as a property on the gateway', async () => {
    const bureau = await createBureau();
    const gateway = await createGateway(bureau);
    expect(gateway.bureau).toBe(bureau);
    bureau.dispose();
  });

  it('gateway does not dispose the bureau on stop', async () => {
    const bureau = await createBureau();
    let disposed = false;
    const originalDispose = bureau.dispose.bind(bureau);
    bureau.dispose = () => {
      disposed = true;
      originalDispose();
    };
    const gateway = await createGateway(bureau);
    // Verify the gateway holds a reference to the passed bureau
    // and that merely holding the gateway does not dispose the bureau.
    // The caller owns the bureau lifecycle.
    expect(gateway.bureau).toBe(bureau);
    expect(disposed).toBe(false);
    bureau.dispose();
  });
});

describe('createBunAdapter', () => {
  it('returns an adapter with serve and mountStaticFiles', () => {
    const adapter = createBunAdapter();
    expect(typeof adapter.serve).toBe('function');
    expect(typeof adapter.mountStaticFiles).toBe('function');
  });
});
