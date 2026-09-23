import { z } from 'zod';

import { createTool, type ToolContext, withContext } from './index';

createTool({
  name: 'base-context-only',
  description: 'direct tools receive only runtime context',
  input: z.object({}),
  async execute(_params, context) {
    context.progress({ percent: 1 });
    context.dispatch(new Event('checked'));
    void context.signal;
    void context.executionContext;
    return 'ok';
  },
});

createTool({
  name: 'rejects-custom-context',
  description: 'direct tools cannot require fields runtime does not create',
  input: z.object({}),
  // @ts-expect-error Direct runtime execution creates ToolContext only; use withContext for custom fields.
  async execute(_params, context: ToolContext & { workspaceId: string }) {
    return context.workspaceId;
  },
});

const contextualTool = withContext(
  { workspaceId: 'workspace-a', role: 'admin' },
  {
    name: 'with-context-direct',
    description: 'context wrapper supplies custom fields',
    input: z.object({ value: z.string() }),
    async execute({ value }, context) {
      context.progress({ message: context.workspaceId });
      return value + ':' + context.role;
    },
  },
);

void contextualTool;

const regionalTool = withContext({ region: 'eu' })({
  name: 'with-context-curried',
  description: 'curried context wrapper supplies custom fields',
  input: z.object({ value: z.number() }),
  async execute({ value }, context) {
    return context.region + ':' + value.toString();
  },
});

void regionalTool;
