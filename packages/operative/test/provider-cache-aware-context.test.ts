/**
 * Cache-aware context assembly for the Anthropic provider.
 *
 * Spec: when `assembler` + `contextBudget` are supplied, `createAnthropicProvider`
 * (and its streaming counterpart) run the context assembler in stable-prefix
 * mode instead of sending the conversation verbatim, and the resulting
 * `cacheBoundary` mark is lowered to Anthropic's `cache_control` breakpoint —
 * built on the conversation-level `cacheBoundary` mechanism, not a parallel one.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createContextAssembler } from '../src/context/assembly.ts';
import { createTokenBudget } from '../src/context/token-budget.ts';
import {
  createAnthropicProvider,
  createAnthropicProviderStream,
} from '../src/providers/anthropic.ts';
import { createMockAnthropicClient } from '../src/providers/test/mock-clients.ts';
import type { GenerateContext, StreamingHandle } from '../src/types.ts';

function makeContext(conversation: Conversation): GenerateContext {
  return { conversation, step: 0, toolbox: createToolbox([]) };
}

function makeStreamingHandle(): StreamingHandle {
  return { update: () => {} };
}

function textResponse(text = 'ok') {
  return {
    content: [{ type: 'text' as const, text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe('Anthropic provider cache-aware context assembly', () => {
  it('attaches cache_control to the system block when assembler + contextBudget are set', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const client = createMockAnthropicClient([textResponse()]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      assembler: createContextAssembler(),
      contextBudget: createTokenBudget({ maxTokens: 100000 }),
    });

    await generate(makeContext(conversation));

    const call = client._calls[0];
    expect(call?.['system']).toEqual([
      { type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('does not set cache_control when assembler/contextBudget are absent (backward compatible)', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const client = createMockAnthropicClient([textResponse()]);
    const generate = createAnthropicProvider({ model: 'claude-3-5-sonnet-20241022', client });

    await generate(makeContext(conversation));

    const call = client._calls[0];
    expect(call?.['system']).toBe('You are a helpful assistant.');
  });

  it('marks the last pinned message when pinnedMessages are configured', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('System prompt');
    conversation.appendUserMessage('Hello');

    const client = createMockAnthropicClient([textResponse(), textResponse()]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      assembler: createContextAssembler(),
      contextBudget: createTokenBudget({ maxTokens: 100000 }),
      pinnedMessages: [
        {
          id: 'pinned-1',
          role: 'user',
          content: 'Pinned reference content',
          position: 0,
          createdAt: new Date().toISOString(),
          metadata: {},
          hidden: false,
        },
      ],
    });

    await generate(makeContext(conversation));

    const call = client._calls[0];
    // The system message stays unmarked — the pinned message (which comes
    // after it) is now the last message of the stable prefix.
    expect(call?.['system']).toBe('System prompt');
    const messages = call?.['messages'] as Array<{ content: unknown }>;
    // The pinned message and the conversation's own "Hello" user message are
    // consecutive same-role messages, so the adapter consolidates them into
    // one Anthropic message with two content blocks — cache_control lands on
    // the pinned block only, since that's the last message of the stable prefix.
    const blocks = messages[0]?.content as Array<Record<string, unknown>>;
    expect(blocks).toEqual([
      { type: 'text', text: 'Pinned reference content', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Hello' },
    ]);
  });

  it('keeps the cache boundary on the stable prefix across steps as the conversation grows', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Turn 1');

    const client = createMockAnthropicClient([textResponse(), textResponse(), textResponse()]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      assembler: createContextAssembler(),
      contextBudget: createTokenBudget({ maxTokens: 100000 }),
    });

    await generate(makeContext(conversation));
    conversation.appendAssistantMessage('Reply 1');
    conversation.appendUserMessage('Turn 2');
    await generate(makeContext(conversation));
    conversation.appendAssistantMessage('Reply 2');
    conversation.appendUserMessage('Turn 3');
    await generate(makeContext(conversation));

    for (const call of client._calls) {
      expect(call['system']).toEqual([
        {
          type: 'text',
          text: 'You are a helpful assistant.',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    }
  });

  it('streams with the same cache-aware assembly as the non-streaming provider', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('You are a helpful assistant.');
    conversation.appendUserMessage('Hello');

    const { createMockAnthropicStreamingClient } =
      await import('../src/providers/test/mock-clients.ts');
    const client = createMockAnthropicStreamingClient([
      [
        { type: 'message_start', message: { usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
        { type: 'message_delta', usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ],
    ]);
    const generate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client,
      assembler: createContextAssembler(),
      contextBudget: createTokenBudget({ maxTokens: 100000 }),
    });

    await generate({ ...makeContext(conversation), streaming: makeStreamingHandle() });

    const call = client._calls[0];
    expect(call?.['system']).toEqual([
      { type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral' } },
    ]);
  });
});
