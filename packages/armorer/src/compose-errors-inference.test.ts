import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from './create-tool';
import { pipe, PipelineError } from './utilities';

describe('PipelineError', () => {
  it('has correct name', () => {
    const error = new PipelineError('test', {
      stepIndex: 0,
      stepName: 'test-step',
      originalError: new Error('original'),
    });

    expect(error.name).toBe('PipelineError');
  });

  it('exposes context', () => {
    const original = new Error('original');
    const error = new PipelineError('test message', {
      stepIndex: 2,
      stepName: 'my-step',
      originalError: original,
    });

    expect(error.message).toBe('test message');
    expect(error.context.stepIndex).toBe(2);
    expect(error.context.stepName).toBe('my-step');
    expect(error.context.originalError).toBe(original);
  });
});

describe('type inference', () => {
  // These tests are primarily compile-time checks
  // If they compile, the type inference is working

  it('infers input type from first tool', async () => {
    const toNumber = createTool({
      name: 'to-number',
      description: 'Parses string to number',
      input: z.object({ value: z.string() }),
      execute: async ({ value }) => ({ value: parseInt(value, 10) }),
    });

    const add10 = createTool({
      name: 'add-10',
      description: 'Adds 10',
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => ({ value: value + 10 }),
    });

    const pipeline = pipe(toNumber, add10);

    // TypeScript should know this expects { value: string }
    const result = await pipeline({ value: '5' });
    expect(result).toMatchObject({ value: 15 });
  });

  it('preserves type through multiple steps', async () => {
    interface User {
      id: string;
      name: string;
    }

    interface EnrichedUser extends User {
      enriched: true;
    }

    const fetchUser = createTool({
      name: 'fetch-user',
      description: 'Fetches user by ID',
      input: z.object({ id: z.string() }),
      execute: async ({ id }): Promise<User> => ({ id, name: 'Test User' }),
    });

    const enrichUser = createTool({
      name: 'enrich-user',
      description: 'Enriches user data',
      input: z.object({ id: z.string(), name: z.string() }),
      execute: async (user): Promise<EnrichedUser> => ({ ...user, enriched: true }),
    });

    const formatUser = createTool({
      name: 'format-user',
      description: 'Formats user for display',
      input: z.object({ id: z.string(), name: z.string(), enriched: z.literal(true) }),
      execute: async (user) => `User ${user.id}: ${user.name} (enriched: ${user.enriched})`,
    });

    const pipeline = pipe(fetchUser, enrichUser, formatUser);
    const result = await pipeline({ id: 'user-123' });

    expect(result).toBe('User user-123: Test User (enriched: true)');
  });
});
