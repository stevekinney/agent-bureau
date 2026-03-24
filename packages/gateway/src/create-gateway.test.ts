import { describe, expect, it } from 'bun:test';
import { createStore } from 'sentinel';

import { createGateway } from './create-gateway';
import { DEFAULT_PORT } from './types';

describe('createGateway', () => {
  it('creates a gateway with default options', () => {
    const gateway = createGateway();
    expect(gateway.app).toBeDefined();
    expect(gateway.store).toBeDefined();
    expect(gateway.port).toBe(DEFAULT_PORT);
  });

  it('uses a custom port', () => {
    const gateway = createGateway({ port: 9999 });
    expect(gateway.port).toBe(9999);
  });

  it('uses a provided store', () => {
    const store = createStore();
    const gateway = createGateway({ store });
    expect(gateway.store).toBe(store);
  });

  it('default port is 5555', () => {
    expect(DEFAULT_PORT).toBe(5555);
  });

  it('exposes a start function', () => {
    const gateway = createGateway();
    expect(typeof gateway.start).toBe('function');
  });
});
