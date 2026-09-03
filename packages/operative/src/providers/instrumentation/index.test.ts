/**
 * `instrument` backend-descriptor propagation (AB-64, AB-245, AB-288).
 * The tracing behavior itself has no pre-existing tests in this package;
 * these cover only the descriptor-attachment contract AB-288 adds.
 */
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createAgent } from '../../create-agent';
import { readGenerationProfile } from '../../generation-profile';
import type { GenerateContext, GenerateFunction } from '../../types';
import { readBackendDescriptors, withBackendDescriptors } from '../backend-descriptor-attachment';
import { createModelCatalog } from '../model-catalog';
import { instrument } from './index';

const FIXED_NOW = () => '2026-09-02T12:00:00.000Z';

function anthropicDescriptor() {
  const descriptor = createModelCatalog({ now: FIXED_NOW }).descriptors.find(
    (row) => row.provider === 'anthropic',
  );
  if (!descriptor)
    throw new Error('expected at least one anthropic descriptor in the seed catalog');
  return descriptor;
}

function makeContext(): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createTestToolbox([]),
  };
}

function noopGenerate(): GenerateFunction {
  return async () => ({ content: 'ok', toolCalls: [] });
}

describe('instrument — backend-descriptor propagation', () => {
  it("preserves the wrapped function's attached descriptors on the returned wrapper", async () => {
    const descriptor = anthropicDescriptor();
    const generate = withBackendDescriptors(noopGenerate(), [descriptor]);

    const wrapped = instrument(generate, { provider: 'anthropic', model: descriptor.model });

    expect(readBackendDescriptors(wrapped)).toEqual([descriptor]);
    // The wrapper still functions as a normal GenerateFunction.
    expect(wrapped(makeContext())).resolves.toEqual({ content: 'ok', toolCalls: [] });
  });

  it("reports a fixed generation profile, not opaque, for an Agent whose generate is the wrapper's output", () => {
    const descriptor = anthropicDescriptor();
    const generate = withBackendDescriptors(noopGenerate(), [descriptor]);
    const wrapped = instrument(generate, { provider: 'anthropic', model: descriptor.model });

    const agent = createAgent({ generate: wrapped });

    expect(readGenerationProfile(agent).mode).toBe('fixed');
  });
});
