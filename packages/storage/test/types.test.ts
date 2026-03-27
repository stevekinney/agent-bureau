import { describe, expect, it } from 'bun:test';

import type { KeyValueStore } from '../src/types';

describe('KeyValueStore interface', () => {
  it('can be satisfied by a minimal object with the 4 required methods', () => {
    const store: KeyValueStore = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    };

    expect(store).toBeDefined();
    expect(store.get).toBeFunction();
    expect(store.set).toBeFunction();
    expect(store.delete).toBeFunction();
    expect(store.list).toBeFunction();
  });

  it('optional methods are truly optional', () => {
    const minimal: KeyValueStore = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    };

    expect(minimal.has).toBeUndefined();
    expect(minimal.deletePrefix).toBeUndefined();
    expect(minimal.close).toBeUndefined();
  });

  it('can include optional methods', () => {
    const full: KeyValueStore = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      has: () => Promise.resolve(false),
      deletePrefix: () => Promise.resolve(0),
      close: () => Promise.resolve(),
    };

    expect(full.has).toBeFunction();
    expect(full.deletePrefix).toBeFunction();
    expect(full.close).toBeFunction();
  });
});
