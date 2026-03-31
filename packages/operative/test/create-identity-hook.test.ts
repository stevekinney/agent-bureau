import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from '../src/conditions/predicates';
import { createIdentityHook } from '../src/create-identity-hook';
import { run } from '../src/run';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [], usage: undefined };
}

describe('createIdentityHook', () => {
  it('injects identity as a system message on step 0', async () => {
    const conversation = new Conversation();
    const hook = createIdentityHook({
      resolve: async () => 'You are a helpful assistant.\n\n## Role\n\nResearch agent.',
    });

    const generate = createMockGenerate([textResponse('Done')]);

    await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      prepareStep: hook,
    });

    const messages = conversation.getMessages({ includeHidden: true });
    const systemMessages = messages.filter((m) => m.role === 'system');

    const identityMessage = systemMessages.find((m) => {
      if (typeof m.content !== 'string') return false;
      return m.content.includes('You are a helpful assistant.');
    });

    expect(identityMessage).toBeDefined();
  });

  it('does not re-inject identity on subsequent steps', async () => {
    const conversation = new Conversation();
    let resolveCallCount = 0;

    const hook = createIdentityHook({
      resolve: async () => {
        resolveCallCount++;
        return 'Identity content.';
      },
    });

    const generate = createMockGenerate([textResponse('Step 1'), textResponse('Step 2')]);

    await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      maximumSteps: 2,
      prepareStep: hook,
    });

    // Resolve should only be called once (on step 0)
    expect(resolveCallCount).toBe(1);
  });

  it('proceeds gracefully when resolve throws', async () => {
    const conversation = new Conversation();
    const hook = createIdentityHook({
      resolve: async () => {
        throw new Error('Storage unavailable');
      },
    });

    const generate = createMockGenerate([textResponse('Done')]);

    // Should NOT throw
    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      prepareStep: hook,
    });

    expect(result.content).toBe('Done');
  });

  it('includes the full resolved identity string', async () => {
    const conversation = new Conversation();
    const fullIdentity =
      'Be helpful.\nBe concise.\n\n## Role\n\nYou are Atlas, a research agent.\n\n## User Context\n\nUser: Steve, UTC.';

    const hook = createIdentityHook({
      resolve: async () => fullIdentity,
    });

    const generate = createMockGenerate([textResponse('Done')]);

    await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      prepareStep: hook,
    });

    const messages = conversation.getMessages({ includeHidden: true });
    const systemMessages = messages.filter(
      (m) => m.role === 'system' && typeof m.content === 'string',
    );

    const hasIdentity = systemMessages.some(
      (m) =>
        typeof m.content === 'string' &&
        m.content.includes('Be helpful.') &&
        m.content.includes('User: Steve'),
    );

    expect(hasIdentity).toBe(true);
  });

  it('handles empty resolve result without injecting', async () => {
    const conversation = new Conversation();
    const hook = createIdentityHook({
      resolve: async () => '',
    });

    const generate = createMockGenerate([textResponse('Done')]);

    await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      prepareStep: hook,
    });

    const messages = conversation.getMessages({ includeHidden: true });
    const identityMessages = messages.filter(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.metadata?.['_identityInjected'] === true,
    );

    expect(identityMessages).toHaveLength(0);
  });

  it('does not resolve identity again when it was already injected earlier', async () => {
    const conversation = new Conversation();
    let resolveCallCount = 0;

    conversation.appendSystemMessage('Existing identity', {
      _identityInjected: true,
    });

    const hook = createIdentityHook({
      resolve: async () => {
        resolveCallCount++;
        return 'Should not be used';
      },
    });

    await run({
      generate: createMockGenerate([textResponse('Done')]),
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      prepareStep: hook,
    });

    expect(resolveCallCount).toBe(0);
    expect(
      conversation
        .getMessages({ includeHidden: true })
        .filter((message) => message.metadata?.['_identityInjected'] === true),
    ).toHaveLength(1);
  });
});
