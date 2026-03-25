import { describe, expect, it } from 'bun:test';
import { createStore } from 'sentinel';

import { createGateway } from './create-gateway';
import { DEFAULT_PORT } from './types';

describe('createGateway', () => {
  it('creates a gateway with default options', async () => {
    const gateway = await createGateway();
    expect(gateway.app).toBeDefined();
    expect(gateway.store).toBeDefined();
    expect(gateway.port).toBe(DEFAULT_PORT);
  });

  it('uses a custom port', async () => {
    const gateway = await createGateway({ port: 9999 });
    expect(gateway.port).toBe(9999);
  });

  it('uses a provided store', async () => {
    const store = createStore();
    const gateway = await createGateway({ store });
    expect(gateway.store).toBe(store);
  });

  it('default port is 5555', () => {
    expect(DEFAULT_PORT).toBe(5555);
  });

  it('exposes a start function', async () => {
    const gateway = await createGateway();
    expect(typeof gateway.start).toBe('function');
  });
});
