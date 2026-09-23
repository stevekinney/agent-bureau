import { describe, expect, it } from 'bun:test';
import { createFanOutRouting, createRoundRobinRouting } from './create-supervisor';
import type { AgentDescriptor } from './supervisor-contracts';

// ---------------------------------------------------------------------------
// Built-in routing strategies
// ---------------------------------------------------------------------------

describe('createRoundRobinRouting', () => {
  it('cycles through descriptors in order across calls', () => {
    const routing = createRoundRobinRouting();
    const descriptors: readonly AgentDescriptor[] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];

    expect(routing('t1', descriptors)).toBe('a');
    expect(routing('t2', descriptors)).toBe('b');
    expect(routing('t3', descriptors)).toBe('c');
    expect(routing('t4', descriptors)).toBe('a');
  });

  it('throws when there are no agents to route to', () => {
    const routing = createRoundRobinRouting();
    expect(() => routing('t1', [])).toThrow('No agents available for routing');
  });
});

describe('createFanOutRouting', () => {
  it('selects every descriptor', () => {
    const routing = createFanOutRouting();
    const descriptors: readonly AgentDescriptor[] = [{ name: 'a' }, { name: 'b' }];

    expect(routing('t1', descriptors)).toEqual(['a', 'b']);
  });

  it('selects nothing when the catalog is empty', () => {
    const routing = createFanOutRouting();
    expect(routing('t1', [])).toEqual([]);
  });
});
