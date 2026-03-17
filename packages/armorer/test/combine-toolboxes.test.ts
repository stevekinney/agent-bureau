import { describe, expect, expectTypeOf, it } from 'bun:test';
import { z } from 'zod';

import { combineToolbox, combineToolboxes, createTool, createToolbox } from '../src';

describe('combineToolboxes', () => {
  it('throws when no toolboxes are provided', () => {
    const combine = combineToolboxes as unknown as () => ReturnType<typeof createToolbox>;
    expect(() => combine()).toThrow('combineToolboxes() requires at least 1 Toolbox');
  });

  it('combines tools from multiple toolboxes', async () => {
    const a = createToolbox([
      {
        name: 'tool-a',
        description: 'tool a',
        input: z.object({}),
        execute: async () => 'A',
      },
    ]);

    const b = createToolbox([
      {
        name: 'tool-b',
        description: 'tool b',
        input: z.object({}),
        execute: async () => 'B',
      },
    ]);

    const combined = combineToolboxes(a, b);

    const resA = await combined.execute({ id: 'a-1', name: 'tool-a', arguments: {} });
    const resB = await combined.execute({ id: 'b-1', name: 'tool-b', arguments: {} });

    expect(resA.result).toBe('A');
    expect(resB.result).toBe('B');
  });

  it('prefers later toolboxes on name collisions', async () => {
    const first = createToolbox([
      {
        name: 'echo',
        description: 'echo',
        input: z.object({ value: z.string() }),
        execute: async ({ value }) => `first:${value}`,
      },
    ]);

    const second = createToolbox([
      {
        name: 'echo',
        description: 'echo',
        input: z.object({ value: z.string() }),
        execute: async ({ value }) => `second:${value}`,
      },
    ]);

    const combined = combineToolboxes(first, second);
    const res = await combined.execute({
      id: 'echo-1',
      name: 'echo',
      arguments: { value: 'hi' },
    });

    expect(res.result).toBe('second:hi');
  });

  it('merges contexts from all toolboxes (last wins)', async () => {
    const a = createToolbox(
      [
        {
          name: 'ctx',
          description: 'ctx',
          input: z.object({}),
          execute: async (_params, context) => {
            const ctx = context as Record<string, unknown>;
            return {
              workspaceId: ctx.workspaceId,
              role: ctx.role,
              shared: ctx.shared,
            };
          },
        },
      ],
      {
        context: { workspaceId: 'ws-1', shared: 'a' },
      },
    );

    const b = createToolbox([], {
      context: { role: 'admin', shared: 'b' },
    });

    const combined = combineToolboxes(a, b);
    const res = await combined.execute({ id: 'ctx-1', name: 'ctx', arguments: {} });

    expect(res.result).toEqual({
      workspaceId: 'ws-1',
      role: 'admin',
      shared: 'b',
    });
  });

  it('preserves tool type information', () => {
    const alpha = createTool({
      name: 'alpha',
      description: 'alpha',
      input: z.object({}),
      execute: async () => 'alpha',
    });
    const beta = createTool({
      name: 'beta',
      description: 'beta',
      input: z.object({}),
      execute: async () => 'beta',
    });

    const a = createToolbox([alpha] as const);
    const b = createToolbox([beta] as const);
    const combined = combineToolboxes(a, b);

    expectTypeOf<ReturnType<typeof combined.tools>[number]['name']>().toEqualTypeOf<
      'alpha' | 'beta'
    >();
  });
});

describe('combineToolbox', () => {
  it('is a compatibility alias of combineToolboxes', async () => {
    const a = createToolbox([
      {
        name: 'alias-a',
        description: 'a',
        input: z.object({}),
        execute: async () => 'A',
      },
    ]);
    const b = createToolbox([
      {
        name: 'alias-b',
        description: 'b',
        input: z.object({}),
        execute: async () => 'B',
      },
    ]);

    const combined = combineToolbox(a, b);
    const result = await combined.execute({ id: 'alias', name: 'alias-b', arguments: {} });
    expect(result.result).toBe('B');
  });
});
