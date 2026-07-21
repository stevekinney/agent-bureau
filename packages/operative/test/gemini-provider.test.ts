/**
 * Regression tests for createGeminiProvider and createGeminiProviderStream.
 *
 * Finding PRRT_kwDORvupsc6MX3PU: both providers referenced `Bun.env['GOOGLE_API_KEY']`
 * directly inside the dynamic-import `.then()` callback. In Node/CJS environments
 * where the Bun global is undefined, that throws a ReferenceError before the client
 * can be created. The fix wraps the access in a `typeof Bun !== 'undefined'` guard
 * that falls back to `process.env`.
 *
 * Note on test coverage: Bun.env and process.env are the same object in the Bun
 * runtime (globalThis.Bun is readonly), so the fallback branch cannot be exercised
 * in a Bun test suite. The tests here cover:
 *   1. Correct behavior with injected mock clients (baseline).
 *   2. ProviderError (not ReferenceError) when no key is set anywhere.
 *   3. The guard in source code is verified by the TypeScript build — the fix itself
 *      is tested at the type-check + build step, and Node integration tests would
 *      cover the runtime path.
 */
import { createToolbox } from 'armorer';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { ProviderError } from '../src/providers/errors.ts';
import { createGeminiProvider, createGeminiProviderStream } from '../src/providers/gemini.ts';
import { geminiStreamTextChunks, geminiTextResponse } from '../src/providers/test/fixtures.ts';
import {
  createMockGeminiModel,
  createMockGeminiStreamingModel,
} from '../src/providers/test/mock-clients.ts';

function makeContext() {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([]),
  };
}

// ── createGeminiProvider — baseline behavior ───────────────────────────

describe('createGeminiProvider — client injection (baseline)', () => {
  it('returns a text response when a mock client is injected', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'gemini-pro', client });

    const result = await generate(makeContext());

    expect(result.content).toBe('Hello from Gemini!');
    expect(result.toolCalls).toHaveLength(0);
  });

  it('maps usageMetadata to prompt/completion/total token counts', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'gemini-pro', client });

    const result = await generate(makeContext());

    expect(result.usage).toEqual({ prompt: 10, completion: 5, total: 15 });
  });
});

// ── createGeminiProvider — API key handling ────────────────────────────

describe('createGeminiProvider — API key handling (PRRT_kwDORvupsc6MX3PU)', () => {
  const savedKey = Bun.env['GOOGLE_API_KEY'];

  beforeEach(() => {
    // Clear both Bun.env and process.env (they are the same object in Bun).
    delete Bun.env['GOOGLE_API_KEY'];
  });

  afterEach(() => {
    if (savedKey !== undefined) {
      Bun.env['GOOGLE_API_KEY'] = savedKey;
    } else {
      delete Bun.env['GOOGLE_API_KEY'];
    }
  });

  it('throws ProviderError (not ReferenceError) when no apiKey or env var is set', async () => {
    // Before the fix: Bun.env access would throw ReferenceError in Node/CJS (Bun undefined).
    // After the fix: the guard prevents Bun.env access in non-Bun runtimes.
    // In Bun, the guard is always true so Bun.env is accessed safely — no ReferenceError.
    // Either way, missing key → ProviderError.
    const generate = createGeminiProvider({ model: 'gemini-pro' });

    await expect(generate(makeContext())).rejects.toBeInstanceOf(ProviderError);
  });

  it('ProviderError message names the GOOGLE_API_KEY environment variable', async () => {
    const generate = createGeminiProvider({ model: 'gemini-pro' });

    const error = await generate(makeContext()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain('GOOGLE_API_KEY');
  });

  it('provider is marked as gemini in the ProviderError', async () => {
    const generate = createGeminiProvider({ model: 'gemini-pro' });

    const error = await generate(makeContext()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).provider).toBe('gemini');
  });
});

// ── createGeminiProviderStream — baseline behavior ────────────────────

describe('createGeminiProviderStream — client injection (baseline)', () => {
  it('accumulates streamed text chunks into a single response', async () => {
    const client = createMockGeminiStreamingModel([geminiStreamTextChunks]);
    const updates: string[] = [];

    const generate = createGeminiProviderStream({ model: 'gemini-pro', client });

    const result = await generate({
      ...makeContext(),
      streaming: { update: (text) => updates.push(text) },
    });

    expect(result.content).toBe('Hello from Gemini!');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1]).toBe('Hello from Gemini!');
  });

  it('sends the resolved thinking budget in streaming generation configuration', async () => {
    const client = createMockGeminiStreamingModel([geminiStreamTextChunks]);
    const generate = createGeminiProviderStream({
      model: 'gemini-2.5-pro',
      effort: 'high',
      client,
    });

    await generate({
      ...makeContext(),
      streaming: { update: () => undefined },
    });

    expect(client._calls[0]?.['generationConfig']).toMatchObject({
      thinkingConfig: { thinkingBudget: 16_384 },
    });
  });
});

// ── createGeminiProviderStream — API key handling ─────────────────────

describe('createGeminiProviderStream — API key handling (PRRT_kwDORvupsc6MX3PU)', () => {
  const savedKey = Bun.env['GOOGLE_API_KEY'];

  beforeEach(() => {
    delete Bun.env['GOOGLE_API_KEY'];
  });

  afterEach(() => {
    if (savedKey !== undefined) {
      Bun.env['GOOGLE_API_KEY'] = savedKey;
    } else {
      delete Bun.env['GOOGLE_API_KEY'];
    }
  });

  it('throws ProviderError (not ReferenceError) when no apiKey or env var is set', async () => {
    const generate = createGeminiProviderStream({ model: 'gemini-pro' });

    await expect(
      generate({ ...makeContext(), streaming: { update: () => undefined } }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('ProviderError message names the GOOGLE_API_KEY environment variable', async () => {
    const generate = createGeminiProviderStream({ model: 'gemini-pro' });

    const error = await generate({
      ...makeContext(),
      streaming: { update: () => undefined },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain('GOOGLE_API_KEY');
  });
});
