/**
 * The Agent generation profile (AB-64 AC2/AC9, AB-245). Written test-first,
 * covering the four `GenerationMode`s, reference-identity/frozen-snapshot,
 * and (in `create-lazy-generate.test.ts`/`create-lazy-agent.test.ts`) the
 * throwing-loader assertions proving a profile read never loads.
 */
import { describe, expect, it } from 'bun:test';

import { readGenerationProfile } from './generation-profile.ts';
import type { BackendDescriptor } from './providers/model-catalog.ts';
import { createModelCatalog } from './providers/model-catalog.ts';
import type { RunnableAgent } from './runnable-agent.ts';

const FIXED_NOW = () => '2026-09-02T12:00:00.000Z';

function seedDescriptor(provider: 'anthropic' | 'openai' | 'gemini'): BackendDescriptor {
  const descriptor = createModelCatalog({ now: FIXED_NOW }).descriptors.find(
    (row) => row.provider === provider,
  );
  if (!descriptor)
    throw new Error(`expected at least one ${provider} descriptor in the seed catalog`);
  return descriptor;
}

function agentWithProfile(generationProfile: RunnableAgent['generationProfile']): RunnableAgent {
  return {
    name: 'test-agent',
    run: () => {
      throw new Error('not exercised by these tests');
    },
    ...(generationProfile ? { generationProfile } : {}),
  };
}

describe('readGenerationProfile — an agent with no generationProfile', () => {
  it('reports mode: opaque, no descriptors, and an unavailable selector', () => {
    const profile = readGenerationProfile(agentWithProfile(undefined));
    expect(profile.mode).toBe('opaque');
    expect(profile.descriptors).toEqual([]);
    expect(profile.selector).toBe('unavailable');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(readGenerationProfile(agentWithProfile(undefined)))).toBe(true);
  });

  it('returns the identical object by reference across two consecutive reads', () => {
    const agent = agentWithProfile(undefined);
    expect(readGenerationProfile(agent)).toBe(readGenerationProfile(agent));
  });

  it('returns the identical object by reference across two different profile-less agents', () => {
    const first = readGenerationProfile(agentWithProfile(undefined));
    const second = readGenerationProfile(agentWithProfile(undefined));
    expect(first).toBe(second);
  });
});

describe('readGenerationProfile — an agent with its own generationProfile', () => {
  it('fixed mode: exactly one descriptor', () => {
    const descriptor = seedDescriptor('anthropic');
    const agent = agentWithProfile({
      mode: 'fixed',
      revision: 1,
      projection: 'privileged',
      descriptors: [descriptor],
      freshness: FIXED_NOW(),
      selector: 'unavailable',
    });

    const profile = readGenerationProfile(agent);
    expect(profile.mode).toBe('fixed');
    expect(profile.descriptors).toEqual([descriptor]);
  });

  it('routed mode: more than one descriptor', () => {
    const agent = agentWithProfile({
      mode: 'routed',
      revision: 1,
      projection: 'privileged',
      descriptors: [seedDescriptor('anthropic'), seedDescriptor('openai')],
      freshness: FIXED_NOW(),
      selector: 'unavailable',
    });

    const profile = readGenerationProfile(agent);
    expect(profile.mode).toBe('routed');
    expect(profile.descriptors).toHaveLength(2);
  });

  it('selectable mode always reports selector: unavailable when read directly off a standalone agent', () => {
    const agent = agentWithProfile({
      mode: 'selectable',
      revision: 1,
      projection: 'privileged',
      descriptors: [],
      allowedCandidates: [{ provider: 'anthropic', model: 'claude-opus-4-6' }],
      freshness: FIXED_NOW(),
      selector: 'unavailable',
    });

    const profile = readGenerationProfile(agent);
    expect(profile.mode).toBe('selectable');
    expect(profile.selector).toBe('unavailable');
  });

  it('opaque mode: no descriptor is ever invented for a custom generator', () => {
    const agent = agentWithProfile({
      mode: 'opaque',
      revision: 1,
      projection: 'privileged',
      descriptors: [],
      freshness: FIXED_NOW(),
      selector: 'unavailable',
    });

    expect(readGenerationProfile(agent).descriptors).toEqual([]);
  });

  it('returns the agent-supplied object directly, preserving reference identity across reads', () => {
    const agent = agentWithProfile({
      mode: 'fixed',
      revision: 1,
      projection: 'privileged',
      descriptors: [seedDescriptor('gemini')],
      freshness: FIXED_NOW(),
      selector: 'unavailable',
    });

    const expectedProfile = agent.generationProfile;
    if (!expectedProfile) throw new Error('expected the agent to carry a generationProfile');
    expect(readGenerationProfile(agent)).toBe(readGenerationProfile(agent));
    expect(readGenerationProfile(agent)).toBe(expectedProfile);
  });
});
