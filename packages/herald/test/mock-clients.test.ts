import { describe, expect, it } from 'bun:test';

import {
  createMockAnthropicClient,
  createMockGeminiModel,
  createMockOpenAIClient,
} from '../src/test/mock-clients.ts';

describe('mock client exhaustion', () => {
  it('Anthropic mock throws when responses are exhausted', async () => {
    const client = createMockAnthropicClient([]);
    await expect(client.messages.create({} as any)).rejects.toThrow(
      'MockAnthropicClient: no response at index 0',
    );
  });

  it('OpenAI mock throws when responses are exhausted', async () => {
    const client = createMockOpenAIClient([]);
    await expect(client.chat.completions.create({} as any)).rejects.toThrow(
      'MockOpenAIClient: no response at index 0',
    );
  });

  it('Gemini mock throws when responses are exhausted', async () => {
    const model = createMockGeminiModel([]);
    await expect(model.generateContent({} as any)).rejects.toThrow(
      'MockGeminiModel: no response at index 0',
    );
  });
});
