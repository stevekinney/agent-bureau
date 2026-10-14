/**
 * AB-64's ratified `BackendDescriptor`/`ModelCatalog` seed (AB-243).
 *
 * Written test-first: every assertion below encodes an acceptance criterion
 * from AB-243's description, computed against the provider tables the seed
 * is derived from — never a hand-copied model list — so a later addition to
 * any of those tables without a matching descriptor row fails here.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { defaultPricingTable } from '../cost-estimation.ts';
import { getProviderCapabilities, type ProviderCapabilities } from './capabilities.ts';
import { pricingFor } from './model-catalog-rows.ts';
import {
  type BackendDescriptor,
  createModelCatalog,
  requireLimits,
  requireModalities,
} from './model-catalog.ts';
import {
  ANTHROPIC_EFFORT_SUPPORT,
  GEMINI_THINKING_MODELS,
  OPENAI_REASONING_MODELS,
  resolveAnthropicEffort,
  resolveGeminiEffort,
  resolveOpenAIEffort,
} from './shared/effort.ts';
import {
  ANTHROPIC_MODEL_ALIASES,
  GEMINI_MODEL_ALIASES,
  OPENAI_MODEL_ALIASES,
} from './shared/model-registry.ts';
import { anthropicSamplingSupport } from './shared/sampling.ts';
import type { Effort, ProviderName } from './types.ts';

const FIXED_NOW = '2026-09-02T12:00:00.000Z';
const fixedNow = () => FIXED_NOW;

function descriptorsFor(provider: ProviderName): readonly BackendDescriptor[] {
  return createModelCatalog({ now: fixedNow }).descriptors.filter(
    (descriptor) => descriptor.provider === provider,
  );
}

describe('createModelCatalog: seed model set (computed, not hand-copied)', () => {
  it('covers every Anthropic model named by ANTHROPIC_EFFORT_SUPPORT and ANTHROPIC_MODEL_ALIASES', () => {
    const union = new Set<string>([
      ...Object.keys(ANTHROPIC_EFFORT_SUPPORT),
      ...Object.values(ANTHROPIC_MODEL_ALIASES),
    ]);
    const seedModels = new Set(descriptorsFor('anthropic').map((row) => row.model));
    for (const model of union) {
      expect(seedModels.has(model)).toBe(true);
    }
  });

  it('covers every OpenAI model named by OPENAI_MODEL_ALIASES and OPENAI_REASONING_MODELS', () => {
    const union = new Set<string>([
      ...Object.values(OPENAI_MODEL_ALIASES),
      ...OPENAI_REASONING_MODELS,
    ]);
    const seedModels = new Set(descriptorsFor('openai').map((row) => row.model));
    for (const model of union) {
      expect(seedModels.has(model)).toBe(true);
    }
  });

  it('covers every Gemini model named by GEMINI_MODEL_ALIASES and GEMINI_THINKING_MODELS', () => {
    const union = new Set<string>([
      ...Object.values(GEMINI_MODEL_ALIASES),
      ...GEMINI_THINKING_MODELS,
    ]);
    const seedModels = new Set(descriptorsFor('gemini').map((row) => row.model));
    for (const model of union) {
      expect(seedModels.has(model)).toBe(true);
    }
  });

  it('attributes every defaultPricingTable key to some descriptor row', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    const seedModels = new Set(catalog.descriptors.map((row) => row.model));
    for (const model of Object.keys(defaultPricingTable)) {
      expect(seedModels.has(model)).toBe(true);
    }
  });

  it('produces exactly 31 descriptor rows: 20 Anthropic, 8 OpenAI, 3 Gemini', () => {
    expect(descriptorsFor('anthropic')).toHaveLength(20);
    expect(descriptorsFor('openai')).toHaveLength(8);
    expect(descriptorsFor('gemini')).toHaveLength(3);
    expect(createModelCatalog({ now: fixedNow }).descriptors).toHaveLength(31);
  });

  it('emits no descriptor row for voyage or ollama', () => {
    expect(descriptorsFor('voyage')).toHaveLength(0);
    expect(descriptorsFor('ollama')).toHaveLength(0);
  });

  it('gives every provider at least one row, so the capability projection cannot pass vacuously', () => {
    for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
      expect(descriptorsFor(provider).length).toBeGreaterThan(0);
    }
  });
});

describe('createModelCatalog: one row per (provider, endpoint, model)', () => {
  it('sets endpoint to messages for anthropic, chat.completions for openai, generateContent for gemini', () => {
    for (const row of descriptorsFor('anthropic')) expect(row.endpoint).toBe('messages');
    for (const row of descriptorsFor('openai')) expect(row.endpoint).toBe('chat.completions');
    for (const row of descriptorsFor('gemini')) expect(row.endpoint).toBe('generateContent');
  });

  it('never emits a duplicate (provider, endpoint, model) triple', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    const seen = new Set<string>();
    for (const row of catalog.descriptors) {
      const key = `${row.provider}::${row.endpoint}::${row.model}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('createModelCatalog: EffortSupport.degradesTo is derived, never a second table', () => {
  const TIERS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('matches resolveAnthropicEffort for every tier on every Anthropic row', () => {
    for (const row of descriptorsFor('anthropic')) {
      for (const tier of TIERS) {
        expect(row.effort.degradesTo[tier]).toBe(resolveAnthropicEffort(tier, row.model));
      }
    }
  });

  it('matches resolveOpenAIEffort for every tier on every OpenAI row', () => {
    for (const row of descriptorsFor('openai')) {
      for (const tier of TIERS) {
        expect(row.effort.degradesTo[tier]).toBe(resolveOpenAIEffort(tier, row.model));
      }
    }
  });

  it('matches resolveGeminiEffort for every tier on every Gemini row', () => {
    for (const row of descriptorsFor('gemini')) {
      for (const tier of TIERS) {
        expect(row.effort.degradesTo[tier]).toBe(resolveGeminiEffort(tier, row.model)?.effort);
      }
    }
  });
});

describe('createModelCatalog: EffortSupport.nativeMapping', () => {
  it('is output_config.effort for every Anthropic row', () => {
    for (const row of descriptorsFor('anthropic')) {
      expect(row.effort.nativeMapping).toBe('output_config.effort');
    }
  });

  it('is reasoning_effort for OpenAI rows in OPENAI_REASONING_MODELS, unsupported otherwise', () => {
    for (const row of descriptorsFor('openai')) {
      const expected = OPENAI_REASONING_MODELS.has(row.model) ? 'reasoning_effort' : 'unsupported';
      expect(row.effort.nativeMapping).toBe(expected);
    }
  });

  it('is thinkingConfig.thinkingBudget for Gemini rows in GEMINI_THINKING_MODELS, unsupported otherwise', () => {
    for (const row of descriptorsFor('gemini')) {
      const expected = GEMINI_THINKING_MODELS.has(row.model)
        ? 'thinkingConfig.thinkingBudget'
        : 'unsupported';
      expect(row.effort.nativeMapping).toBe(expected);
    }
  });
});

describe('createModelCatalog: parameterCompatibility', () => {
  it('omits requestMetadata for Gemini rows', () => {
    for (const row of descriptorsFor('gemini')) {
      expect(row.parameterCompatibility).not.toContain('requestMetadata');
    }
  });

  it('includes requestMetadata for Anthropic and OpenAI rows', () => {
    for (const row of [...descriptorsFor('anthropic'), ...descriptorsFor('openai')]) {
      expect(row.parameterCompatibility).toContain('requestMetadata');
    }
  });
});

describe('createModelCatalog: Anthropic sampling parameters follow the documented per-model decision', () => {
  // Models the cited pages do not settle (see shared/sampling.ts): conservatively not advertised.
  const UNSETTLED = ['claude-haiku-4-20250506', 'claude-3-5-haiku-20241022'];

  it('advertises temperature and topP exactly when the model is recorded as accepting them', () => {
    for (const row of descriptorsFor('anthropic')) {
      const advertised = ['temperature', 'topP'].map((field) =>
        row.parameterCompatibility.includes(field as 'temperature' | 'topP'),
      );
      const accepted = anthropicSamplingSupport(row.model) === 'accepted';
      expect([row.model, advertised]).toEqual([row.model, [accepted, accepted]]);
    }
  });

  it('records a decision for every Anthropic row except the documented unsettled ones', () => {
    const undecided = descriptorsFor('anthropic')
      .map((row) => row.model)
      .filter((model) => anthropicSamplingSupport(model) === 'unsettled');
    expect(undecided.toSorted()).toEqual(UNSETTLED.toSorted());
  });

  it('does not advertise sampling for the current Claude models, which reject it', () => {
    for (const model of [
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-5',
    ]) {
      const row = descriptorsFor('anthropic').find((candidate) => candidate.model === model);
      expect(row?.parameterCompatibility).not.toContain('temperature');
      expect(row?.parameterCompatibility).not.toContain('topP');
    }
  });

  it('still advertises sampling for models that accept it', () => {
    for (const model of ['claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-4-6']) {
      const row = descriptorsFor('anthropic').find((candidate) => candidate.model === model);
      expect(row?.parameterCompatibility).toContain('temperature');
      expect(row?.parameterCompatibility).toContain('topP');
    }
  });

  it('keeps every other parameter, including toolChoice, on every Anthropic row', () => {
    for (const row of descriptorsFor('anthropic')) {
      for (const field of [
        'model',
        'effort',
        'maximumTokens',
        'stopSequences',
        'toolChoice',
        'responseFormat',
        'requestMetadata',
      ] as const) {
        expect(row.parameterCompatibility).toContain(field);
      }
    }
  });

  it('leaves OpenAI and Gemini rows advertising sampling', () => {
    for (const row of [...descriptorsFor('openai'), ...descriptorsFor('gemini')]) {
      expect(row.parameterCompatibility).toContain('temperature');
      expect(row.parameterCompatibility).toContain('topP');
    }
  });
});

describe('createModelCatalog: Haiku 5.5 carries its long-context tier', () => {
  it('exposes the tier on the descriptor and no tier on a flat-priced model', () => {
    const rows = createModelCatalog({ now: fixedNow }).descriptors;
    expect(rows.find((row) => row.model === 'claude-haiku-5-5')?.pricing?.longContext).toEqual({
      inputTokensAbove: 100_000,
      inputPerMillionTokens: 0.5,
      outputPerMillionTokens: 2.5,
    });
    expect(
      rows.find((row) => row.model === 'claude-haiku-4-5')?.pricing?.longContext,
    ).toBeUndefined();
  });
});

describe('createModelCatalog: access-restricted Anthropic models', () => {
  it('reports Mythos availability as unknown and every other Anthropic row as available', () => {
    for (const row of descriptorsFor('anthropic')) {
      expect([row.model, row.availability]).toEqual([
        row.model,
        row.model.startsWith('claude-mythos') ? 'unknown' : 'available',
      ]);
    }
  });
});

describe('createModelCatalog: pricing is derived from defaultPricingTable, never fabricated', () => {
  it('matches promptCostPerMillionTokens/completionCostPerMillionTokens exactly, in USD, for every priced model', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    for (const [model, priced] of Object.entries(defaultPricingTable)) {
      const row = catalog.descriptors.find((descriptor) => descriptor.model === model);
      expect(row).toBeDefined();
      expect(row?.pricing).toEqual({
        inputPerMillionTokens: priced.promptCostPerMillionTokens,
        outputPerMillionTokens: priced.completionCostPerMillionTokens,
        currency: 'USD',
        ...(priced.longContext
          ? {
              longContext: {
                inputTokensAbove: priced.longContext.inputTokensAbove,
                inputPerMillionTokens: priced.longContext.promptCostPerMillionTokens,
                outputPerMillionTokens: priced.longContext.completionCostPerMillionTokens,
              },
            }
          : {}),
      });
    }
  });

  it('omits the pricing field entirely for a model with no defaultPricingTable row', () => {
    expect(pricingFor('claude-unpriced-fixture')).toBeUndefined();
  });

  it('prices every catalog row, so no resolvable model reports a fabricated or missing cost', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    for (const row of catalog.descriptors) {
      expect({ model: row.model, priced: 'pricing' in row }).toEqual({
        model: row.model,
        priced: true,
      });
    }
  });
});

describe('createModelCatalog: MODEL_LIMITS / MODEL_MODALITIES completeness', () => {
  it('never emits contextWindowTokens: 0 or maxOutputTokens: 0', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    for (const row of catalog.descriptors) {
      expect(row.contextWindowTokens).toBeGreaterThan(0);
      expect(row.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it('requireLimits throws for a model with no MODEL_LIMITS row', () => {
    expect(() => requireLimits('anthropic', 'not-a-real-model')).toThrow();
    expect(() => requireLimits('openai', 'not-a-real-model')).toThrow();
    expect(() => requireLimits('gemini', 'not-a-real-model')).toThrow();
  });

  it('requireModalities throws for a model with no MODEL_MODALITIES row', () => {
    expect(() => requireModalities('anthropic', 'not-a-real-model')).toThrow();
    expect(() => requireModalities('openai', 'not-a-real-model')).toThrow();
    expect(() => requireModalities('gemini', 'not-a-real-model')).toThrow();
  });

  it('populates a modalities entry for every Modality key on every row', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    const modalityKeys = ['text', 'image', 'audio', 'video', 'document', 'file'] as const;
    for (const row of catalog.descriptors) {
      for (const modality of modalityKeys) {
        expect(row.modalities[modality]).toBeDefined();
      }
    }
  });
});

describe('createModelCatalog: endpointAmbiguous (OpenAI only)', () => {
  it('is true and reports all four capability flags false when openAIBaseURL is a non-empty string', () => {
    const catalog = createModelCatalog({
      now: fixedNow,
      openAIBaseURL: 'https://proxy.internal/v1',
    });
    for (const row of catalog.descriptors.filter((r) => r.provider === 'openai')) {
      expect(row.endpointAmbiguous).toBe(true);
      expect(row.caching).toBe(false);
      expect(row.batchInference).toBe(false);
      expect(row.explicitThinkingRequest).toBe(false);
      expect(row.serverSideTokenCounting).toBe(false);
      expect(row.availability).toBe('unknown');
    }
  });

  it('treats an empty-string openAIBaseURL as the default endpoint (not ambiguous)', () => {
    const catalog = createModelCatalog({ now: fixedNow, openAIBaseURL: '' });
    for (const row of catalog.descriptors.filter((r) => r.provider === 'openai')) {
      expect(row.endpointAmbiguous).toBe(false);
      expect(row.availability).toBe('available');
    }
  });

  it('does not mark anthropic or gemini rows ambiguous', () => {
    const catalog = createModelCatalog({
      now: fixedNow,
      openAIBaseURL: 'https://proxy.internal/v1',
    });
    for (const row of catalog.descriptors) {
      if (row.provider === 'openai') continue;
      expect(row.endpointAmbiguous).toBeUndefined();
    }
  });
});

describe('createModelCatalog: catalog invariants', () => {
  it('is deeply frozen: the catalog, its descriptors array, and each descriptor', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.descriptors)).toBe(true);
    for (const row of catalog.descriptors) {
      expect(Object.isFrozen(row)).toBe(true);
    }
  });

  it("is deeply frozen one level into a descriptor's own nested values", () => {
    const catalog = createModelCatalog({ now: fixedNow });
    for (const row of catalog.descriptors) {
      expect(Object.isFrozen(row.aliases)).toBe(true);
      expect(Object.isFrozen(row.mimeFamilies)).toBe(true);
      expect(Object.isFrozen(row.mediaLimits)).toBe(true);
      expect(Object.isFrozen(row.parameterCompatibility)).toBe(true);
      expect(Object.isFrozen(row.effort)).toBe(true);
      expect(Object.isFrozen(row.effort.portable)).toBe(true);
      expect(Object.isFrozen(row.effort.degradesTo)).toBe(true);
      expect(Object.isFrozen(row.modalities)).toBe(true);
      if (row.pricing) expect(Object.isFrozen(row.pricing)).toBe(true);
    }
  });

  it('starts at revision 1', () => {
    expect(createModelCatalog({ now: fixedNow }).revision).toBe(1);
  });

  it('reports the privileged projection', () => {
    expect(createModelCatalog({ now: fixedNow }).projection).toBe('privileged');
  });

  it('is never stale on construction', () => {
    expect(createModelCatalog({ now: fixedNow }).stale).toBe(false);
  });

  it('reads only the injected clock for generatedAt and every descriptor freshness', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    expect(catalog.generatedAt).toBe(FIXED_NOW);
    for (const row of catalog.descriptors) {
      expect(row.freshness).toBe(FIXED_NOW);
    }
  });

  it('defaults now to a real ISO timestamp when not injected, without this test reading the wall clock', () => {
    const catalog = createModelCatalog();
    expect(Number.isNaN(Date.parse(catalog.generatedAt))).toBe(false);
    for (const row of catalog.descriptors) {
      expect(row.freshness).toBe(catalog.generatedAt);
    }
  });

  it('a manual RuntimeServices controls generatedAt and every descriptor freshness when now is not injected (AB-325)', async () => {
    const runtime = createManualRuntimeServices();
    await runtime.advance(54_321);

    const catalog = createModelCatalog({ runtime });

    expect(catalog.generatedAt).toBe(runtime.clock.nowISO());
    for (const row of catalog.descriptors) {
      expect(row.freshness).toBe(catalog.generatedAt);
    }
  });

  it('an explicit now still takes precedence over runtime when both are supplied', () => {
    const runtime = createManualRuntimeServices();
    const catalog = createModelCatalog({ now: fixedNow, runtime });

    expect(catalog.generatedAt).toBe(FIXED_NOW);
  });
});

// ── getProviderCapabilities: characterization against pre-AB-64 behavior ───
//
// `capabilities.ts`'s public signature and answers must stay bit-for-bit
// identical to what it returned before this change. These four expectation
// tables are the exact values the pre-AB-64 hand-maintained switch statement
// returned (see the deleted hunk of `capabilities.ts` in this pull request's
// diff) — never re-derived from the new module, so this test cannot pass by
// construction.

const ANTHROPIC_EXPECTED: ProviderCapabilities = {
  batchInference: true,
  explicitThinkingRequest: true,
  requestControlledContextCaching: true,
  serverSideTokenCounting: true,
};

const GEMINI_EXPECTED: ProviderCapabilities = {
  batchInference: true,
  explicitThinkingRequest: false,
  requestControlledContextCaching: true,
  serverSideTokenCounting: true,
};

const NO_CAPABILITIES_EXPECTED: ProviderCapabilities = {
  batchInference: false,
  explicitThinkingRequest: false,
  requestControlledContextCaching: false,
  serverSideTokenCounting: false,
};

const OPENAI_DEFAULT_ENDPOINT_EXPECTED: ProviderCapabilities = {
  batchInference: true,
  explicitThinkingRequest: false,
  requestControlledContextCaching: false,
  serverSideTokenCounting: false,
};

const OPENAI_AMBIGUOUS_ENDPOINT_EXPECTED: ProviderCapabilities = NO_CAPABILITIES_EXPECTED;

/** Runs `body` with `OPENAI_BASE_URL` set to `value` (or unset for `undefined`), then restores it. */
async function withOpenAIBaseUrl<T>(
  value: string | undefined,
  body: () => T | Promise<T>,
): Promise<T> {
  const previous = process.env['OPENAI_BASE_URL'];
  if (value === undefined) delete process.env['OPENAI_BASE_URL'];
  else process.env['OPENAI_BASE_URL'] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env['OPENAI_BASE_URL'];
    else process.env['OPENAI_BASE_URL'] = previous;
  }
}

describe('getProviderCapabilities: characterization matrix (four environment states x five providers)', () => {
  let savedOpenAIBaseUrl: string | undefined;

  beforeEach(() => {
    savedOpenAIBaseUrl = process.env['OPENAI_BASE_URL'];
    delete process.env['OPENAI_BASE_URL'];
  });

  afterEach(() => {
    if (savedOpenAIBaseUrl === undefined) delete process.env['OPENAI_BASE_URL'];
    else process.env['OPENAI_BASE_URL'] = savedOpenAIBaseUrl;
  });

  it('state 1: baseURL unset, OPENAI_BASE_URL unset', async () => {
    await withOpenAIBaseUrl(undefined, () => {
      expect(getProviderCapabilities('anthropic')).toEqual(ANTHROPIC_EXPECTED);
      expect(getProviderCapabilities('openai')).toEqual(OPENAI_DEFAULT_ENDPOINT_EXPECTED);
      expect(getProviderCapabilities('gemini')).toEqual(GEMINI_EXPECTED);
      expect(getProviderCapabilities('voyage')).toEqual(NO_CAPABILITIES_EXPECTED);
      expect(getProviderCapabilities('ollama')).toEqual(NO_CAPABILITIES_EXPECTED);
    });
  });

  it('state 2: baseURL set, OPENAI_BASE_URL unset', async () => {
    await withOpenAIBaseUrl(undefined, () => {
      expect(
        getProviderCapabilities('anthropic', { baseURL: 'https://proxy.internal/v1' }),
      ).toEqual(ANTHROPIC_EXPECTED);
      expect(getProviderCapabilities('openai', { baseURL: 'https://proxy.internal/v1' })).toEqual(
        OPENAI_AMBIGUOUS_ENDPOINT_EXPECTED,
      );
      expect(getProviderCapabilities('gemini', { baseURL: 'https://proxy.internal/v1' })).toEqual(
        GEMINI_EXPECTED,
      );
      expect(getProviderCapabilities('voyage', { baseURL: 'https://proxy.internal/v1' })).toEqual(
        NO_CAPABILITIES_EXPECTED,
      );
      expect(getProviderCapabilities('ollama', { baseURL: 'https://proxy.internal/v1' })).toEqual(
        NO_CAPABILITIES_EXPECTED,
      );
    });
  });

  it('state 3: baseURL unset, OPENAI_BASE_URL set (non-empty)', async () => {
    await withOpenAIBaseUrl('http://localhost:1234/v1', () => {
      expect(getProviderCapabilities('anthropic')).toEqual(ANTHROPIC_EXPECTED);
      expect(getProviderCapabilities('openai')).toEqual(OPENAI_AMBIGUOUS_ENDPOINT_EXPECTED);
      expect(getProviderCapabilities('gemini')).toEqual(GEMINI_EXPECTED);
      expect(getProviderCapabilities('voyage')).toEqual(NO_CAPABILITIES_EXPECTED);
      expect(getProviderCapabilities('ollama')).toEqual(NO_CAPABILITIES_EXPECTED);
    });
  });

  it('state 4: baseURL unset, OPENAI_BASE_URL set to the empty string', async () => {
    await withOpenAIBaseUrl('', () => {
      expect(getProviderCapabilities('anthropic')).toEqual(ANTHROPIC_EXPECTED);
      expect(getProviderCapabilities('openai')).toEqual(OPENAI_DEFAULT_ENDPOINT_EXPECTED);
      expect(getProviderCapabilities('gemini')).toEqual(GEMINI_EXPECTED);
      expect(getProviderCapabilities('voyage')).toEqual(NO_CAPABILITIES_EXPECTED);
      expect(getProviderCapabilities('ollama')).toEqual(NO_CAPABILITIES_EXPECTED);
    });
  });
});
