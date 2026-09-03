/**
 * AB-64's five-layer model policy precedence composition (AB-248).
 *
 * Written test-first: one case per exclusion code `composePolicy` can
 * produce, one monotonic-narrowing case per layer boundary, the
 * override-denied-above-the-user case, and the repeat-determinism case.
 * Descriptors are built from `createModelCatalog` with an injected `now`
 * so no fixture carries a wall-clock timestamp.
 */
import { describe, expect, it } from 'bun:test';

import { type BackendDescriptor, createModelCatalog } from './model-catalog.ts';
import {
  type BureauInvariants,
  composePolicy,
  type DelegatedAuthority,
  type DeploymentInvariants,
  type UserModelConfiguration,
} from './policy.ts';

const FIXED_NOW = '2026-09-02T12:00:00.000Z';

const CATALOG = createModelCatalog({ now: () => FIXED_NOW });

function descriptor(provider: string, model: string): BackendDescriptor {
  const found = CATALOG.descriptors.find((row) => row.provider === provider && row.model === model);
  if (found === undefined) {
    throw new Error(`fixture descriptor not found: ${provider}/${model}`);
  }
  return found;
}

const anthropic = descriptor('anthropic', 'claude-fable-5');
const openai = descriptor('openai', 'gpt-4o');
const gemini = descriptor('gemini', 'gemini-2.5-pro');
// o3's portable effort tiers stop at 'high' (no xhigh/max), giving a
// non-empty-but-not-maximal `highestPortableEffort`, unlike claude-fable-5
// (tops out at 'max', so nothing can exceed it) or gpt-4o (empty, so the
// exceeds check never reaches the "highest is defined" branch).
const openaiO3 = descriptor('openai', 'o3');

describe('composePolicy: availability and health', () => {
  it('excludes a descriptor whose availability is unavailable', () => {
    const unavailable: BackendDescriptor = { ...anthropic, availability: 'unavailable' };
    const [candidate] = composePolicy({ descriptors: [unavailable] });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('unavailable');
  });

  it('excludes a descriptor whose health is unhealthy', () => {
    const unhealthy: BackendDescriptor = { ...anthropic, health: 'unhealthy' };
    const [candidate] = composePolicy({ descriptors: [unhealthy] });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('unhealthy');
  });
});

describe('composePolicy: deployment invariants', () => {
  it('excludes a denied provider with denied-by-deployment', () => {
    const deployment: DeploymentInvariants = { deniedProviders: ['anthropic'] };
    const [candidate] = composePolicy({ descriptors: [anthropic], deployment });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('denied-by-deployment');
  });

  it('excludes a denied model with denied-by-deployment', () => {
    const deployment: DeploymentInvariants = { deniedModels: [openai.model] };
    const [candidate] = composePolicy({ descriptors: [openai], deployment });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('denied-by-deployment');
  });

  it('reports denied-by-deployment for a candidate denied by both deployment and the user', () => {
    const deployment: DeploymentInvariants = { deniedProviders: ['anthropic'] };
    const user: UserModelConfiguration = { deniedProviders: ['anthropic'] };
    const [candidate] = composePolicy({ descriptors: [anthropic], deployment, user });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('denied-by-deployment');
  });
});

describe('composePolicy: Bureau invariants', () => {
  it('excludes a candidate the Bureau layer denies with denied-by-bureau', () => {
    const bureau: BureauInvariants = { deniedProviders: ['openai'] };
    const [candidate] = composePolicy({ descriptors: [openai], bureau });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('denied-by-bureau');
  });

  it('never re-admits a candidate the deployment layer denied, regardless of the Bureau value', () => {
    const deployment: DeploymentInvariants = { deniedProviders: ['anthropic'] };
    const bureau: BureauInvariants = {}; // does not deny anthropic itself
    const [candidate] = composePolicy({ descriptors: [anthropic], deployment, bureau });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('denied-by-deployment');
  });

  it('never re-admits a candidate even when the Bureau value explicitly allows it via an unrelated field', () => {
    const deployment: DeploymentInvariants = { deniedModels: [gemini.model] };
    const bureau: BureauInvariants = { deniedProviders: ['openai'] };
    const [candidate] = composePolicy({ descriptors: [gemini], deployment, bureau });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('denied-by-deployment');
  });
});

describe('composePolicy: Agent requirements and preferences', () => {
  it('excludes a candidate missing a required capability with missing-required-capability', () => {
    const noBatch: BackendDescriptor = { ...anthropic, batchInference: false };
    const [candidate] = composePolicy({
      descriptors: [noBatch],
      agent: { requiredCapabilities: ['batchInference'] },
    });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('missing-required-capability');
  });

  it('excludes a candidate below minimumContextWindowTokens with missing-required-capability', () => {
    const [candidate] = composePolicy({
      descriptors: [openai],
      agent: { minimumContextWindowTokens: openai.contextWindowTokens + 1 },
    });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('missing-required-capability');
  });

  it('excludes nothing for preferredProviders and preferredModels, carrying them through untouched', () => {
    const [candidate] = composePolicy({
      descriptors: [openai],
      agent: { preferredProviders: ['anthropic'], preferredModels: ['claude-fable-5'] },
    });
    expect(candidate?.eligible).toBe(true);
  });

  it('treats a non-empty array-valued field as a present capability', () => {
    // `aliases` is array-typed; claude-fable-5 has at least one alias in the
    // seed, so this exercises hasCapability's Array.isArray branch on the
    // "present" side and lets the requiredCapabilities loop run to completion
    // without excluding.
    expect(anthropic.aliases.length).toBeGreaterThan(0);
    const [candidate] = composePolicy({
      descriptors: [anthropic],
      agent: { requiredCapabilities: ['aliases'] },
    });
    expect(candidate?.eligible).toBe(true);
  });

  it('excludes a candidate with an empty array-valued required capability', () => {
    // `aliases` is array-typed; force it empty to exercise the "present but
    // zero-length" side of hasCapability's Array.isArray branch, distinct
    // from the non-empty case above.
    const noAliases: BackendDescriptor = { ...anthropic, aliases: [] };
    const [candidate] = composePolicy({
      descriptors: [noAliases],
      agent: { requiredCapabilities: ['aliases'] },
    });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('missing-required-capability');
  });

  it('treats a non-boolean, non-array, defined field as a present capability', () => {
    // `contextWindowTokens` is neither boolean nor array — exercises
    // hasCapability's final `value !== undefined && value !== null` branch.
    const [candidate] = composePolicy({
      descriptors: [anthropic],
      agent: { requiredCapabilities: ['contextWindowTokens'] },
    });
    expect(candidate?.eligible).toBe(true);
  });
});

describe('composePolicy: delegated authority', () => {
  it('excludes a provider not in grantedProviders with exceeds-delegated-authority and a traceable policyVersion', () => {
    const delegated: DelegatedAuthority = {
      grantedProviders: ['openai'],
      policyVersion: 'grant-v1',
    };
    const [candidate] = composePolicy({ descriptors: [anthropic], delegated });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('exceeds-delegated-authority');
    expect(candidate?.exclusionReason).toContain('grant-v1');
  });

  it('excludes a model not in grantedModels with exceeds-delegated-authority', () => {
    const delegated: DelegatedAuthority = { grantedModels: ['gpt-4.1'], policyVersion: 'grant-v1' };
    const [candidate] = composePolicy({ descriptors: [openai], delegated });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('exceeds-delegated-authority');
    expect(candidate?.exclusionReason).toContain('grant-v1');
  });

  it('excludes an effort above the candidate supported tier when the candidate supports no effort at all', () => {
    const delegated: DelegatedAuthority = { maximumEffort: 'low', policyVersion: 'grant-v1' };
    // gpt-4o's portable effort tiers are empty, so any maximumEffort exceeds it.
    const [candidate] = composePolicy({ descriptors: [openai], delegated });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('exceeds-delegated-authority');
    expect(candidate?.exclusionReason).toContain('grant-v1');
  });

  it('excludes an effort above the candidate supported tier when the candidate supports a lesser tier', () => {
    // o3's portable tiers stop at 'high' — requesting 'xhigh' exceeds a
    // defined (non-empty) highest tier, unlike the empty-portable case above.
    const delegated: DelegatedAuthority = { maximumEffort: 'xhigh', policyVersion: 'grant-v1' };
    const [candidate] = composePolicy({ descriptors: [openaiO3], delegated });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('exceeds-delegated-authority');
    expect(candidate?.exclusionReason).toContain('grant-v1');
  });

  it('narrows nothing when maximumEffort is within the candidate supported tier', () => {
    const delegated: DelegatedAuthority = { maximumEffort: 'medium', policyVersion: 'grant-v1' };
    const [candidate] = composePolicy({ descriptors: [openaiO3], delegated });
    expect(candidate?.eligible).toBe(true);
  });

  it('narrows nothing when grantedProviders and grantedModels are both absent', () => {
    const delegated: DelegatedAuthority = { policyVersion: 'grant-v1' };
    const [candidate] = composePolicy({ descriptors: [anthropic], delegated });
    expect(candidate?.eligible).toBe(true);
  });
});

describe('composePolicy: user constraints and preferences', () => {
  it('excludes a denied provider with denied-by-user', () => {
    const user: UserModelConfiguration = { deniedProviders: ['anthropic'] };
    const [candidate] = composePolicy({ descriptors: [anthropic], user });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('denied-by-user');
  });

  it('excludes a denied model with denied-by-user', () => {
    const user: UserModelConfiguration = { deniedModels: [openai.model] };
    const [candidate] = composePolicy({ descriptors: [openai], user });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('denied-by-user');
  });

  it('excludes everything not named when allowedProviders is present', () => {
    const user: UserModelConfiguration = { allowedProviders: ['gemini'] };
    const [candidate] = composePolicy({ descriptors: [anthropic], user });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('denied-by-user');
  });

  it('narrows nothing when every user list is absent', () => {
    const [candidate] = composePolicy({ descriptors: [anthropic], user: {} });
    expect(candidate?.eligible).toBe(true);
  });

  it('excludes every candidate when allowedRoutes is present, since no descriptor carries a route to name', () => {
    const user: UserModelConfiguration = { allowedRoutes: ['primary'] };
    const [candidate] = composePolicy({ descriptors: [anthropic], user });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('denied-by-user');
  });

  it('narrows nothing when only deniedRoutes is present, since no descriptor route can ever match it', () => {
    const user: UserModelConfiguration = { deniedRoutes: ['primary'] };
    const [candidate] = composePolicy({ descriptors: [anthropic], user });
    expect(candidate?.eligible).toBe(true);
  });

  it('excludes every candidate when allowedRegions is present, since no descriptor carries a region to name', () => {
    const user: UserModelConfiguration = { allowedRegions: ['us-east'] };
    const [candidate] = composePolicy({ descriptors: [anthropic], user });
    expect(candidate?.eligible).toBe(false);
    expect(candidate?.exclusionCode).toBe('denied-by-user');
  });

  it('narrows nothing when only deniedRegions is present, since no descriptor region can ever match it', () => {
    const user: UserModelConfiguration = { deniedRegions: ['us-east'] };
    const [candidate] = composePolicy({ descriptors: [anthropic], user });
    expect(candidate?.eligible).toBe(true);
  });
});

describe('composePolicy: exactOverride', () => {
  it('rejects an override denied at the Bureau layer with denied-by-bureau, never denied-by-user', () => {
    const bureau: BureauInvariants = { deniedProviders: ['openai'] };
    const user: UserModelConfiguration = {
      deniedProviders: ['anthropic', 'gemini'], // would also deny everything else, proving the override skips this
      exactOverride: { provider: 'openai', model: openai.model },
    };
    const result = composePolicy({ descriptors: [anthropic, openai, gemini], bureau, user });
    expect(result).toHaveLength(1);
    expect(result[0]?.eligible).toBe(false);
    expect(result[0]?.exclusionCode).toBe('denied-by-bureau');
  });

  it('honors an override that clears every layer above the user, bypassing the general user deny list', () => {
    const user: UserModelConfiguration = {
      deniedProviders: ['anthropic'], // would normally deny this candidate
      exactOverride: { provider: 'anthropic', model: anthropic.model },
    };
    const result = composePolicy({ descriptors: [anthropic, openai], user });
    expect(result).toHaveLength(1);
    expect(result[0]?.eligible).toBe(true);
    expect(result[0]?.provider).toBe('anthropic');
  });

  it('yields an empty result when the override names no matching descriptor', () => {
    const user: UserModelConfiguration = {
      exactOverride: { provider: 'anthropic', model: 'no-such-model' },
    };
    const result = composePolicy({ descriptors: [anthropic, openai], user });
    expect(result).toHaveLength(0);
  });

  it('yields an empty result for a partially specified override naming only a provider', () => {
    // An "exact" override must identify exactly one descriptor; provider
    // alone could match many, so it resolves to none rather than an
    // ambiguous multi-candidate result.
    const user: UserModelConfiguration = { exactOverride: { provider: 'anthropic' } };
    const result = composePolicy({ descriptors: [anthropic, openai, gemini], user });
    expect(result).toHaveLength(0);
  });

  it('yields an empty result for a partially specified override naming only an effort', () => {
    const user: UserModelConfiguration = { exactOverride: { effort: 'low' } };
    const result = composePolicy({ descriptors: [anthropic, openai, gemini], user });
    expect(result).toHaveLength(0);
  });

  it('yields at most one candidate even if descriptors contains duplicate rows for the same provider and model', () => {
    const duplicate: BackendDescriptor = { ...anthropic };
    const user: UserModelConfiguration = {
      exactOverride: { provider: anthropic.provider, model: anthropic.model },
    };
    const result = composePolicy({ descriptors: [anthropic, duplicate], user });
    expect(result).toHaveLength(1);
  });
});

describe('composePolicy: general contract', () => {
  it('returns one candidate per input descriptor, in input order, dropping nothing', () => {
    const result = composePolicy({ descriptors: [gemini, anthropic, openai] });
    expect(result).toHaveLength(3);
    expect(result.map((candidate) => candidate.model)).toEqual([
      gemini.model,
      anthropic.model,
      openai.model,
    ]);
    expect(result.every((candidate) => candidate.eligible)).toBe(true);
  });

  it('returns a frozen array of frozen candidates', () => {
    const result = composePolicy({ descriptors: [anthropic] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });

  it('is deterministic: composing the same input twice yields deeply equal output, including exclusion ordering', () => {
    const deployment: DeploymentInvariants = { deniedProviders: ['gemini'] };
    const bureau: BureauInvariants = { deniedModels: [openai.model] };
    const agent = { minimumContextWindowTokens: 1000 };
    const delegated: DelegatedAuthority = {
      grantedProviders: ['anthropic', 'openai', 'gemini'],
      policyVersion: 'v1',
    };
    const user: UserModelConfiguration = { deniedRegions: ['eu'] };
    const input = {
      descriptors: [anthropic, openai, gemini],
      deployment,
      bureau,
      agent,
      delegated,
      user,
    };

    const first = composePolicy(input);
    const second = composePolicy(input);

    expect(first).toEqual(second);
    expect(first.map((candidate) => candidate.exclusionCode)).toEqual(
      second.map((candidate) => candidate.exclusionCode),
    );
  });
});
