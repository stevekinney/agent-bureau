import { describe, expect, expectTypeOf, it } from 'bun:test';
import { z } from 'zod';

import { createTool, createToolbox } from '../src';
import { queryTools } from '../src/query';

describe('queryTools type inference', () => {
  it('infers tags and schema keys from typed toolbox entries', () => {
    const sendEmail = createTool({
      name: 'send-email',
      description: 'Send an email message',
      tags: ['communication', 'email'] as const,
      input: z.object({
        to: z.string(),
        body: z.string(),
      }),
      execute: async () => ({ ok: true }),
    });

    const getWeather = createTool({
      name: 'get-weather',
      description: 'Get weather information',
      tags: ['weather', 'read-only'] as const,
      input: z.object({
        city: z.string(),
        units: z.enum(['c', 'f']).optional(),
      }),
      execute: async () => ({ ok: true }),
    });

    const toolbox = createToolbox([sendEmail, getWeather] as const);

    type ToolboxTool = ReturnType<typeof toolbox.tools>[number];
    type Criteria = NonNullable<Parameters<typeof queryTools<ToolboxTool>>[1]>;

    expectTypeOf<NonNullable<Criteria['tags']>>().toMatchTypeOf<{
      any?: readonly ('communication' | 'email' | 'weather' | 'read-only')[];
      all?: readonly ('communication' | 'email' | 'weather' | 'read-only')[];
      none?: readonly ('communication' | 'email' | 'weather' | 'read-only')[];
    }>();

    expectTypeOf<NonNullable<Criteria['schema']>>().toMatchTypeOf<{
      keys?: readonly ('to' | 'body' | 'city' | 'units')[];
    }>();

    const tools = queryTools(toolbox, {
      tags: { any: ['communication'] },
      schema: { keys: ['to'] },
    });

    expectTypeOf<(typeof tools)[number]['name']>().toEqualTypeOf<
      'send-email' | 'get-weather'
    >();

    const names = queryTools(toolbox, { select: 'name' });
    expectTypeOf(names).toEqualTypeOf<string[]>();

    expect(tools.map((tool) => tool.name)).toEqual(['send-email']);
  });
});
