/**
 * Per-run request-metadata passthrough (AB-93).
 *
 * `requestMetadata` is a provider-neutral option: a caller-supplied
 * `Record<string, string>` attaches to every generate request of a run.
 * Anthropic and OpenAI map it to their native `metadata` field; Gemini's
 * `generateContent` API has no request-level metadata field, so it's an
 * explicit no-op there — asserted below by confirming the mock never
 * receives a `metadata` key.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createAnthropicProvider } from '../src/providers/anthropic.ts';
import { createGeminiProvider } from '../src/providers/gemini.ts';
import { createOpenAIProvider } from '../src/providers/openai.ts';
import {
  anthropicTextResponse,
  geminiTextResponse,
  openAITextResponse,
} from '../src/providers/test/fixtures.ts';
import {
  createMockAnthropicClient,
  createMockGeminiModel,
  createMockOpenAIClient,
} from '../src/providers/test/mock-clients.ts';
import type { GenerateContext } from '../src/types.ts';

function makeContext(conversation: Conversation): GenerateContext {
  return { conversation, step: 0, toolbox: createToolbox([]) };
}

/** Runs `generate` three times over a growing conversation. */
async function runThreeStepLoop(
  generate: (context: GenerateContext) => Promise<unknown>,
  conversation: Conversation,
): Promise<void> {
  await generate(makeContext(conversation));
  conversation.appendAssistantMessage('Step 1 reply');
  conversation.appendUserMessage('Step 2');
  await generate(makeContext(conversation));
  conversation.appendAssistantMessage('Step 2 reply');
  conversation.appendUserMessage('Step 3');
  await generate(makeContext(conversation));
}

describe('Per-run request metadata passthrough', () => {
  it('attaches requestMetadata to every Anthropic request of a multi-step run', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Step 1');
    const client = createMockAnthropicClient([
      anthropicTextResponse,
      anthropicTextResponse,
      anthropicTextResponse,
    ]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      requestMetadata: { requestId: 'run-42', tenant: 'acme' },
    });

    await runThreeStepLoop(generate, conversation);

    expect(client._calls).toHaveLength(3);
    for (const call of client._calls) {
      expect(call['metadata']).toEqual({ requestId: 'run-42', tenant: 'acme' });
    }
  });

  it('attaches requestMetadata to every OpenAI request of a multi-step run', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Step 1');
    const client = createMockOpenAIClient([
      openAITextResponse,
      openAITextResponse,
      openAITextResponse,
    ]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o-mini',
      client,
      requestMetadata: { requestId: 'run-42', tenant: 'acme' },
    });

    await runThreeStepLoop(generate, conversation);

    expect(client._calls).toHaveLength(3);
    for (const call of client._calls) {
      expect(call['metadata']).toEqual({ requestId: 'run-42', tenant: 'acme' });
    }
  });

  it('does not send requestMetadata to Gemini (documented no-op)', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Step 1');
    const model = createMockGeminiModel([
      geminiTextResponse,
      geminiTextResponse,
      geminiTextResponse,
    ]);
    const generate = createGeminiProvider({
      model: 'gemini-1.5-flash',
      client: model,
      requestMetadata: { requestId: 'run-42', tenant: 'acme' },
    });

    await runThreeStepLoop(generate, conversation);

    expect(model._calls).toHaveLength(3);
    for (const call of model._calls) {
      // Asserting absence, not just an undefined value — `metadata: undefined`
      // would also satisfy `toBeUndefined()` but is not the documented no-op.
      expect(Object.hasOwn(call, 'metadata')).toBe(false);
    }
  });

  it('omits the metadata key entirely when requestMetadata is not set', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Hello');
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-3-5-sonnet-20241022', client });

    await generate(makeContext(conversation));

    expect(Object.hasOwn(client._calls[0] ?? {}, 'metadata')).toBe(false);
  });
});
