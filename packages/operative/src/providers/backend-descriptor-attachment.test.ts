/**
 * `withBackendDescriptors`/`readBackendDescriptors` (AB-64 AC2, AB-245).
 * Written test-first against the acceptance criteria in AB-245's
 * description before the module existed.
 */
import { describe, expect, it } from 'bun:test';

import { readBackendDescriptors, withBackendDescriptors } from './backend-descriptor-attachment.ts';
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
});
