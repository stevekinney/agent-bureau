import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createSchemaErrorMutator } from '../../src/retry/schema-error-mutator';
import type { GenerateContext } from '../../src/types';

function makeContext(messages?: string[]): GenerateContext {
  const conversation = new Conversation();
  if (messages) {
    for (const content of messages) {
      conversation.appendUserMessage(content);
    }
  }
  return {
    conversation,
    step: 0,
    toolbox: createTestToolbox([]),
  };
}

describe('createSchemaErrorMutator', () => {
  it('returns void for non-validation errors', async () => {
    const mutator = createSchemaErrorMutator();
    const context = makeContext();
    const result = await mutator(context, new Error('network timeout'), 1);
    expect(result).toBeUndefined();
  });

  it('detects errors with an issues property (Zod-like)', async () => {
    const mutator = createSchemaErrorMutator();
    const context = makeContext(['generate something']);

    const error = Object.assign(new Error('Validation failed'), {
      issues: [
        { path: ['name'], message: 'Required', code: 'invalid_type' },
        { path: ['age'], message: 'Expected number, received string', code: 'invalid_type' },
      ],
    });

    const result = await mutator(context, error, 1);
    expect(result).toBeDefined();

    // Should have appended a user message with the validation errors
    const messages = result!.conversation.getMessages();
    const lastMessage = messages[messages.length - 1];
    expect(lastMessage).toBeDefined();
    expect(lastMessage!.role).toBe('user');
    expect(typeof lastMessage!.content === 'string' ? lastMessage!.content : '').toContain(
      'Required',
    );
  });

  it('detects errors with ZodError name', async () => {
    const mutator = createSchemaErrorMutator();
    const context = makeContext(['test']);

    const error = new Error('Validation failed');
    error.name = 'ZodError';

    const result = await mutator(context, error, 1);
    expect(result).toBeDefined();
  });

  it('includes issue details in the injected message', async () => {
    const mutator = createSchemaErrorMutator();
    const context = makeContext(['test']);

    const error = Object.assign(new Error('Validation failed'), {
      issues: [{ path: ['email'], message: 'Invalid email format', code: 'invalid_string' }],
    });

    const result = await mutator(context, error, 1);
    expect(result).toBeDefined();

    const messages = result!.conversation.getMessages();
    const lastMessage = messages[messages.length - 1];
    const content = typeof lastMessage!.content === 'string' ? lastMessage!.content : '';
    expect(content).toContain('email');
    expect(content).toContain('Invalid email format');
  });

  it('does not mutate the original conversation', async () => {
    const mutator = createSchemaErrorMutator();
    const context = makeContext(['test']);
    const originalCount = context.conversation.getMessages().length;

    const error = Object.assign(new Error('Validation failed'), {
      issues: [{ path: ['x'], message: 'bad' }],
    });

    await mutator(context, error, 1);
    expect(context.conversation.getMessages().length).toBe(originalCount);
  });

  it('preserves existing messages in the returned context', async () => {
    const mutator = createSchemaErrorMutator();
    const context = makeContext(['original message']);

    const error = Object.assign(new Error('Validation failed'), {
      issues: [{ path: ['x'], message: 'bad' }],
    });

    const result = await mutator(context, error, 1);
    expect(result).toBeDefined();

    const messages = result!.conversation.getMessages();
    // Original message should still be present
    expect(messages.length).toBeGreaterThan(1);
  });
});
