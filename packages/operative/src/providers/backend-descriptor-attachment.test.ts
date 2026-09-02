/**
 * `withBackendDescriptors`/`readBackendDescriptors` (AB-64 AC2, AB-245).
 * Written test-first against the acceptance criteria in AB-245's
 * description before the module existed.
 */
import { describe, expect, it } from 'bun:test';

import { readBackendDescriptors, withBackendDescriptors } from './backend-descriptor-attachment.ts';
import type { BackendDescriptor } from './model-catalog.ts';
import { createModelCatalog } from './model-catalog.ts';
import type { GenerateFunction } from './types.ts';

const FIXED_NOW = () => '2026-09-02T12:00:00.000Z';

function anthropicDescriptor() {
  const descriptor = createModelCatalog({ now: FIXED_NOW }).descriptors.find(
    (row) => row.provider === 'anthropic',
  );
  if (!descriptor)
    throw new Error('expected at least one anthropic descriptor in the seed catalog');
  return descriptor;
}

function noopGenerate(): GenerateFunction {
  return async () => ({ content: '', toolCalls: [] });
}

describe('readBackendDescriptors', () => {
  it('returns a frozen empty array for a function with nothing attached', () => {
    const descriptors = readBackendDescriptors(noopGenerate());
    expect(descriptors).toEqual([]);
    expect(Object.isFrozen(descriptors)).toBe(true);
  });

  it('never infers a descriptor for a plain function', () => {
    const generate = noopGenerate();
    expect(readBackendDescriptors(generate)).toHaveLength(0);
  });
});

describe('withBackendDescriptors', () => {
  it('attaches descriptors readable back through readBackendDescriptors', () => {
    const descriptor = anthropicDescriptor();
    const generate = withBackendDescriptors(noopGenerate(), [descriptor]);

    expect(readBackendDescriptors(generate)).toEqual([descriptor]);
  });

  it('returns the same generate function it was given, not a wrapper', () => {
    const generate = noopGenerate();
    const returned = withBackendDescriptors(generate, [anthropicDescriptor()]);

    expect(returned).toBe(generate);
  });

  it('freezes the attached descriptor list', () => {
    const generate = withBackendDescriptors(noopGenerate(), [anthropicDescriptor()]);
    expect(Object.isFrozen(readBackendDescriptors(generate))).toBe(true);
  });

  it('defensively copies the input array — later caller mutation does not change the reported descriptors', () => {
    const descriptor = anthropicDescriptor();
    const mutableInput = [descriptor];
    const generate = withBackendDescriptors(noopGenerate(), mutableInput);

    mutableInput.length = 0;

    expect(readBackendDescriptors(generate)).toEqual([descriptor]);
  });

  it('attaches an empty descriptor list without throwing, for a model with no seed row', () => {
    const generate = withBackendDescriptors(noopGenerate(), []);
    expect(readBackendDescriptors(generate)).toEqual([]);
  });

  it('deep-freezes a hand-built (not pre-frozen) descriptor on attachment, closing per-field mutation too (review)', () => {
    // createModelCatalog's own seed rows are already deeply frozen at their
    // source, so the interesting case is a caller-constructed descriptor
    // that starts out fully mutable.
    const modalityEntry = { input: false, output: false, sourceForms: [] };
    const custom: BackendDescriptor = {
      descriptorVersion: 1,
      provider: 'anthropic',
      endpoint: 'messages',
      model: 'custom-model',
      aliases: [{ alias: 'custom-alias', resolvesTo: 'custom-model' }],
      lifecycle: 'stable',
      modalities: {
        text: { input: true, output: true, sourceForms: ['inline'] },
        image: modalityEntry,
        document: modalityEntry,
        audio: modalityEntry,
        video: modalityEntry,
        file: modalityEntry,
      },
      mimeFamilies: [],
      mediaLimits: [],
      contextWindowTokens: 1000,
      maxOutputTokens: 100,
      streaming: true,
      tools: true,
      parallelTools: true,
      structuredOutput: true,
      parameterCompatibility: [],
      caching: false,
      batchInference: false,
      explicitThinkingRequest: false,
      serverSideTokenCounting: false,
      effort: { portable: [], nativeMapping: 'unsupported', degradesTo: {} },
      availability: 'available',
      health: 'unknown',
      source: 'static',
      freshness: '2026-01-01T00:00:00.000Z',
    };
    expect(Object.isFrozen(custom)).toBe(false);

    const generate = withBackendDescriptors(noopGenerate(), [custom]);
    const [attached] = readBackendDescriptors(generate);
    if (!attached) throw new Error('expected exactly one attached descriptor');

    expect(Object.isFrozen(attached)).toBe(true);
    expect(Object.isFrozen(attached.aliases)).toBe(true);
    expect(Object.isFrozen(attached.aliases[0])).toBe(true);
    expect(Object.isFrozen(attached.modalities)).toBe(true);
    expect(Object.isFrozen(attached.modalities.text)).toBe(true);
    expect(Object.isFrozen(attached.effort)).toBe(true);

    // Since custom is frozen IN PLACE (not copied), the caller's own
    // reference is now the same frozen object — mutating a field on it
    // throws in strict mode and, regardless, must never change what a
    // later read reports.
    expect(() => {
      (custom as { model: string }).model = 'mutated';
    }).toThrow();
    expect(readBackendDescriptors(generate)[0]?.model).toBe('custom-model');
  });
});
