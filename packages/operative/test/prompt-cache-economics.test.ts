/**
 * Deterministic bench: demonstrates the token-cost economics of
 * prompt-cache-aware context assembly (AB-63), entirely against the mock
 * Anthropic client — no live API calls.
 *
 * Scenario: a multi-step run with a large, unchanging system prompt (the
 * "stable prefix"). Step 1 is a cold cache write. Every following step
 * reuses that prefix from the cache instead of paying full input price for
 * it again.
 *
 * See `README.md`'s "Cache Economics" note under Context Assembly for the
 * narrative version of these numbers.
 */
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createContextAssembler } from '../src/context/assembly.ts';
import { createTokenBudget } from '../src/context/token-budget.ts';
import { estimateCacheHitRate, estimateCost } from '../src/cost-estimation.ts';
import { createAnthropicProvider } from '../src/providers/anthropic.ts';
import { createMockAnthropicClient } from '../src/providers/test/mock-clients.ts';
import type { GenerateContext } from '../src/types.ts';

const MODEL = 'claude-3-5-sonnet-20241022';
// Roughly 2,000 tokens of unchanging system prompt — big enough that
// re-paying full price for it every step is the expensive failure mode this
// feature avoids, and small enough to keep the fixture readable.
const SYSTEM_PROMPT = 'You are a careful, detail-oriented coding assistant. '.repeat(80);

describe('prompt-cache economics (deterministic bench, no live API calls)', () => {
  it('a cache-aware assembler turns a repeated stable prefix into cache reads instead of fresh prompt tokens', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage(SYSTEM_PROMPT);
    conversation.appendUserMessage('Turn 1');

    // The mock responses model what Anthropic actually reports: the first
    // request against a cold cache pays `cache_creation_input_tokens` for
    // the ~2,000-token system prompt; every subsequent request that hits the
    // same breakpoint pays a much cheaper `cache_read_input_tokens` for it
    // instead of full-price `input_tokens`.
    const client = createMockAnthropicClient([
      {
        content: [{ type: 'text', text: 'ok 1' }],
        usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 2000 },
      },
      {
        content: [{ type: 'text', text: 'ok 2' }],
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 2000 },
      },
      {
        content: [{ type: 'text', text: 'ok 3' }],
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 2000 },
      },
    ]);

    const generate = createAnthropicProvider({
      model: MODEL,
      client,
      assembler: createContextAssembler(),
      contextBudget: createTokenBudget({ maxTokens: 100000 }),
    });

    const makeContext = (): GenerateContext => ({
      conversation,
      step: 0,
      toolbox: { toAnthropicTools: async () => [] } as unknown as GenerateContext['toolbox'],
    });

    const responses = [];
    for (let step = 0; step < 3; step++) {
      if (step > 0) {
        conversation.appendAssistantMessage(`Reply ${step}`);
        conversation.appendUserMessage(`Turn ${step + 1}`);
      }
      responses.push(await generate(makeContext()));
    }

    // Every request marked the SAME cache_control breakpoint at the end of
    // the (unchanging) system prompt — proof the stable prefix, not just the
    // usage numbers, stayed identical across steps.
    for (const call of client._calls) {
      expect(call['system']).toEqual([
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ]);
    }

    // Step 1: cold write, 0% hit rate.
    const usage1 = responses[0]?.usage;
    if (!usage1) throw new Error('expected usage on step 1');
    expect(estimateCacheHitRate(usage1)).toBe(0);

    // Steps 2 and 3: the whole system-prompt prefix comes back as a cache
    // read instead of fresh input tokens.
    const usage2 = responses[1]?.usage;
    const usage3 = responses[2]?.usage;
    if (!usage2 || !usage3) throw new Error('expected usage on steps 2 and 3');
    expect(estimateCacheHitRate(usage2)).toBeCloseTo(2000 / 2005, 5);
    expect(estimateCacheHitRate(usage3)).toBeCloseTo(2000 / 2005, 5);

    // Cost delta: pricing a cache-read step against what it WOULD have cost
    // at full prompt price for the same 2,000 tokens shows the saving
    // `estimateCost` already prices in (Anthropic: cache read = 0.1x prompt).
    const costWithCache = estimateCost(usage2, MODEL);
    const costWithoutCacheUsage = {
      prompt: usage2.prompt + (usage2.cacheReadTokens ?? 0),
      completion: usage2.completion,
      total: usage2.total,
    };
    const costWithoutCache = estimateCost(costWithoutCacheUsage, MODEL);

    expect(costWithCache.totalCost).toBeLessThan(costWithoutCache.totalCost);
    // Anthropic prices a cache read at 0.1x the base prompt rate, so caching
    // this step's 2,000-token prefix should cut its total cost by roughly
    // 90% of what that slice would otherwise have cost.
    const savingsRatio = 1 - costWithCache.totalCost / costWithoutCache.totalCost;
    expect(savingsRatio).toBeGreaterThan(0.8);
  });
});
