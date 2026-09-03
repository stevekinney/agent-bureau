/**
 * AB-64's deterministic backend selector and self-contained `SelectionPlan`
 * (AB-249).
 *
 * Written test-first against the design fixed in `selection.ts`'s top-level
 * documentation. Every test injects `now`/`newPlanId` so plans are
 * byte-stable and comparable with a deep-equality assertion — no sleeps, no
 * timers, no network, no wall-clock read.
 */
import { describe, expect, it } from 'bun:test';

import { type BackendDescriptor, createModelCatalog, type ModelCatalog } from './model-catalog.ts';
import type { UserModelConfiguration } from './policy.ts';
import {
  type EffectiveGenerationResult,
  recordEffectiveGeneration,
  select,
  type SelectionRequest,
  type SelectOptions,
} from './selection.ts';

const FIXED_NOW = '2026-09-02T12:00:00.000Z';
const FIXED_PLAN_ID = 'plan-fixed-0001';

const now = () => FIXED_NOW;
let planIdCounter = 0;
function freshNewPlanId(): () => string {
  planIdCounter = 0;
  return () => `plan-fixed-${String(planIdCounter++).padStart(4, '0')}`;
}

const SEED_CATALOG = createModelCatalog({ now: () => FIXED_NOW });

function descriptor(provider: string, model: string): BackendDescriptor {
  const found = SEED_CATALOG.descriptors.find(
    (row) => row.provider === provider && row.model === model,
  );
  if (found === undefined) {
    throw new Error(`fixture descriptor not found: ${provider}/${model}`);
  }
  return found;
}

const anthropic = descriptor('anthropic', 'claude-fable-5');
const openai = descriptor('openai', 'gpt-4o');
const gemini = descriptor('gemini', 'gemini-2.5-pro');
// No xhigh support: 'xhigh' degrades to 'high' (defined, different tier) —
// the reject-vs-degrade pair's fixture.
const opus45 = descriptor('anthropic', 'claude-opus-4-5');
// Absent from ANTHROPIC_EFFORT_SUPPORT entirely: every tier degrades to
// undefined — the "unsupported at any degradation" fixture.
const haiku45 = descriptor('anthropic', 'claude-haiku-4-5');

function catalogOf(
  descriptors: readonly BackendDescriptor[],
  overrides: Partial<ModelCatalog> = {},
): ModelCatalog {
  return {
    revision: 1,
    descriptors,
    generatedAt: FIXED_NOW,
    stale: false,
    projection: 'privileged',
    ...overrides,
  };
}

function baseRequest(overrides: Partial<SelectionRequest> = {}): SelectionRequest {
  return {
    agentName: 'test-agent',
    catalogRevision: 1,
    policyRevision: 1,
    availabilitySnapshotRevision: 1,
    ...overrides,
  };
}

function baseOptions(catalog: ModelCatalog, overrides: Partial<SelectOptions> = {}): SelectOptions {
  return {
    catalog,
    now,
    newPlanId: freshNewPlanId(),
    ...overrides,
  };
}

describe('select: determinism', () => {
  it('produces deeply equal plans for two calls with the same recorded input', () => {
    const request = baseRequest();
    const options = baseOptions(catalogOf([anthropic, openai]));
    const first = select(request, { ...options, newPlanId: () => FIXED_PLAN_ID });
    const second = select(request, { ...options, newPlanId: () => FIXED_PLAN_ID });
    expect(second).toEqual(first);
  });

  it('is synchronous and returns a plan without a promise', () => {
    const result = select(baseRequest(), baseOptions(catalogOf([anthropic])));
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.outcome).toBe('selected');
  });
});

describe('select: fixed Agent, one eligible descriptor', () => {
  it('yields a one-candidate plan with outcome selected', () => {
    const plan = select(baseRequest(), baseOptions(catalogOf([anthropic])));
    expect(plan.outcome).toBe('selected');
    expect(plan.candidates).toHaveLength(1);
    expect(plan.selected).toEqual({ provider: 'anthropic', model: 'claude-fable-5' });
    expect(plan.failure).toBeUndefined();
  });
});

describe('select: custom opaque generator (empty descriptor set)', () => {
  it('yields empty candidates, an absent selected, and no fabricated descriptor', () => {
    const plan = select(baseRequest(), baseOptions(catalogOf([])));
    expect(plan.outcome).toBe('no-candidate');
    expect(plan.candidates).toEqual([]);
    expect(plan.selected).toBeUndefined();
  });
});

describe('select: descriptorSnapshot replay independence', () => {
  it('keeps reporting the same eligibility reasoning after the source catalog is mutated', () => {
    const mutableDeployment: { deniedProviders: ('anthropic' | 'openai')[] } = {
      deniedProviders: [],
    };
    const descriptors = [{ ...anthropic }, { ...openai }];
    const options = baseOptions(catalogOf(descriptors), { deployment: mutableDeployment });
    const plan = select(baseRequest(), options);

    const anthropicCandidateBefore = plan.candidates.find(
      (candidate) => candidate.provider === 'anthropic',
    );
    expect(anthropicCandidateBefore?.eligible).toBe(true);
    expect(anthropicCandidateBefore?.model).toBe('claude-fable-5');
    expect(anthropicCandidateBefore?.descriptorSnapshot.model).toBe('claude-fable-5');

    // Mutate the source descriptor objects and the deployment rule after
    // the plan was produced — a live reference would flip this candidate to
    // ineligible and rename its snapshot; the plan must not move.
    mutableDeployment.deniedProviders.push('anthropic');
    (descriptors[0] as { model: string }).model = 'mutated-model';

    const anthropicCandidateAfter = plan.candidates.find(
      (candidate) => candidate.provider === 'anthropic',
    );
    expect(anthropicCandidateAfter?.eligible).toBe(true);
    expect(anthropicCandidateAfter?.model).toBe('claude-fable-5');
    expect(anthropicCandidateAfter?.descriptorSnapshot.model).toBe('claude-fable-5');
    expect(anthropicCandidateAfter).toEqual(anthropicCandidateBefore);
  });

  it('keeps reporting the same eligibility reasoning after the source catalog is discarded', () => {
    function buildPlan() {
      const descriptors: readonly BackendDescriptor[] = [anthropic];
      return select(baseRequest(), baseOptions(catalogOf(descriptors)));
    }
    const plan = buildPlan();
    // `descriptors` above is now unreachable — nothing keeps it alive except
    // the plan's own inlined `descriptorSnapshot`.
    expect(plan.candidates[0]?.descriptorSnapshot.provider).toBe('anthropic');
  });

  it('produces a descriptorSnapshot that is not the same object reference as the source descriptor', () => {
    const plan = select(baseRequest(), baseOptions(catalogOf([anthropic])));
    expect(plan.candidates[0]?.descriptorSnapshot).not.toBe(anthropic);
    expect(plan.candidates[0]?.descriptorSnapshot).toEqual(anthropic);
    expect(Object.isFrozen(plan.candidates[0]?.descriptorSnapshot)).toBe(true);
  });
});

describe('select: hard constraints filter before soft preferences rank', () => {
  it('never promotes an ineligible candidate over an eligible one, no matter how strongly it is preferred', () => {
    const options = baseOptions(catalogOf([anthropic, openai]), {
      deployment: { deniedProviders: ['openai'] },
      agent: { preferredProviders: ['openai'], preferredModels: ['gpt-4o'] },
      user: { costPreference: 'lowest-cost' },
    });
    const plan = select(baseRequest(), options);
    expect(plan.outcome).toBe('selected');
    expect(plan.selected?.provider).toBe('anthropic');
    const openaiCandidate = plan.candidates.find((candidate) => candidate.provider === 'openai');
    expect(openaiCandidate?.eligible).toBe(false);
    expect(openaiCandidate?.exclusionCode).toBe('denied-by-deployment');
  });
});

describe('select: rankingInputs', () => {
  it('populates cost, latency, and preferenceMatch for every eligible candidate', () => {
    const plan = select(baseRequest(), baseOptions(catalogOf([anthropic, openai, gemini])));
    expect(plan.outcome).toBe('selected');
    for (const candidate of plan.candidates) {
      expect(candidate.eligible).toBe(true);
      expect(candidate.rankingInputs).toBeDefined();
      expect(typeof candidate.rankingInputs?.['cost']).toBe('number');
      expect(candidate.rankingInputs?.['latency']).toBe(0);
      expect(typeof candidate.rankingInputs?.['preferenceMatch']).toBe('number');
    }
  });

  it('leaves rankingInputs undefined on an ineligible candidate', () => {
    const options = baseOptions(catalogOf([anthropic]), {
      deployment: { deniedProviders: ['anthropic'] },
    });
    const plan = select(baseRequest(), options);
    expect(plan.candidates[0]?.rankingInputs).toBeUndefined();
  });

  it('gives an unpriced descriptor a neutral 0.5 cost score', () => {
    const unpriced: BackendDescriptor = { ...anthropic, pricing: undefined };
    const plan = select(baseRequest(), baseOptions(catalogOf([unpriced])));
    expect(plan.candidates[0]?.rankingInputs?.['cost']).toBe(0.5);
  });

  it('scores every candidate 1 when all priced candidates share the identical price', () => {
    const priceA: BackendDescriptor = {
      ...anthropic,
      provider: 'anthropic',
      model: 'tie-a',
      pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15, currency: 'USD' },
    };
    const priceB: BackendDescriptor = {
      ...anthropic,
      provider: 'anthropic',
      model: 'tie-b',
      pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15, currency: 'USD' },
    };
    const plan = select(baseRequest(), baseOptions(catalogOf([priceA, priceB])));
    for (const candidate of plan.candidates) {
      expect(candidate.rankingInputs?.['cost']).toBe(1);
    }
  });

  it('normalizes cost between two differently priced candidates so the cheaper one scores higher', () => {
    const cheap: BackendDescriptor = {
      ...anthropic,
      provider: 'anthropic',
      model: 'cheap-model',
      pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 1, currency: 'USD' },
    };
    const expensive: BackendDescriptor = {
      ...anthropic,
      provider: 'anthropic',
      model: 'expensive-model',
      pricing: { inputPerMillionTokens: 100, outputPerMillionTokens: 100, currency: 'USD' },
    };
    const plan = select(baseRequest(), baseOptions(catalogOf([cheap, expensive])));
    const cheapCandidate = plan.candidates.find((candidate) => candidate.model === 'cheap-model');
    const expensiveCandidate = plan.candidates.find(
      (candidate) => candidate.model === 'expensive-model',
    );
    expect(cheapCandidate?.rankingInputs?.['cost']).toBe(1);
    expect(expensiveCandidate?.rankingInputs?.['cost']).toBe(0);
  });

  it('reports 0.5 preferenceMatch for one matching preference field and 1 for both', () => {
    const options = baseOptions(catalogOf([anthropic]), {
      agent: { preferredProviders: ['anthropic'] },
    });
    const plan = select(baseRequest(), options);
    expect(plan.candidates[0]?.rankingInputs?.['preferenceMatch']).toBe(0.5);

    const both = baseOptions(catalogOf([anthropic]), {
      agent: { preferredProviders: ['anthropic'], preferredModels: ['claude-fable-5'] },
    });
    const bothPlan = select(baseRequest(), both);
    expect(bothPlan.candidates[0]?.rankingInputs?.['preferenceMatch']).toBe(1);
  });
});

describe('select: ranking picks the cheaper candidate under lowest-cost, ignores cost otherwise', () => {
  const cheap: BackendDescriptor = {
    ...anthropic,
    provider: 'anthropic',
    model: 'zzz-cheap',
    pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 1, currency: 'USD' },
  };
  const expensive: BackendDescriptor = {
    ...anthropic,
    provider: 'anthropic',
    model: 'aaa-expensive',
    pricing: { inputPerMillionTokens: 100, outputPerMillionTokens: 100, currency: 'USD' },
  };

  it('selects the cheaper candidate when costPreference is lowest-cost', () => {
    const options = baseOptions(catalogOf([cheap, expensive]), {
      user: { costPreference: 'lowest-cost' },
    });
    const plan = select(baseRequest(), options);
    expect(plan.selected?.model).toBe('zzz-cheap');
  });

  it('falls back to lexicographic tie-break when cost is unweighted (no-preference)', () => {
    const options = baseOptions(catalogOf([cheap, expensive]), {
      user: { costPreference: 'no-preference' },
    });
    const plan = select(baseRequest(), options);
    expect(plan.selected?.model).toBe('aaa-expensive');
  });

  it('splits the difference under balanced cost preference without erroring', () => {
    const options = baseOptions(catalogOf([cheap, expensive]), {
      user: { costPreference: 'balanced' },
    });
    const plan = select(baseRequest(), options);
    expect(plan.outcome).toBe('selected');
  });

  it('treats an absent costPreference the same as no-preference', () => {
    const options = baseOptions(catalogOf([cheap, expensive]));
    const plan = select(baseRequest(), options);
    expect(plan.selected?.model).toBe('aaa-expensive');
  });

  it('exercises every latencyPreference branch without changing the outcome, since latency is always neutral', () => {
    for (const latencyPreference of [
      'lowest-latency',
      'balanced',
      'no-preference',
      undefined,
    ] as const) {
      const options = baseOptions(catalogOf([cheap, expensive]), {
        user: { latencyPreference },
      });
      const plan = select(baseRequest(), options);
      expect(plan.outcome).toBe('selected');
    }
  });
});

describe('select: tie-break by (provider, model) lexicographic order', () => {
  const candidateAnthropic: BackendDescriptor = {
    ...anthropic,
    provider: 'anthropic',
    model: 'shared-model',
    pricing: undefined,
  };
  const candidateOpenAI: BackendDescriptor = {
    ...openai,
    provider: 'openai',
    model: 'shared-model',
    pricing: undefined,
  };

  it('selects the lexicographically first candidate when ranking inputs are identical', () => {
    const plan = select(
      baseRequest(),
      baseOptions(catalogOf([candidateAnthropic, candidateOpenAI])),
    );
    expect(plan.selected?.provider).toBe('anthropic');
  });

  it('is unaffected by reversing the input array order', () => {
    const plan = select(
      baseRequest(),
      baseOptions(catalogOf([candidateOpenAI, candidateAnthropic])),
    );
    expect(plan.selected?.provider).toBe('anthropic');
  });

  it('resolves a true (provider, model) tie — a duplicate catalog entry — deterministically via the stable sort, never throwing', () => {
    const plan = select(
      baseRequest(),
      baseOptions(catalogOf([candidateAnthropic, { ...candidateAnthropic }])),
    );
    expect(plan.outcome).toBe('selected');
    expect(plan.selected?.provider).toBe('anthropic');
    expect(plan.selected?.model).toBe('shared-model');
    expect(plan.candidates).toHaveLength(2);
  });
});

describe('select: exact override via requestedValue', () => {
  it('rejects an override denied above the user layer with a single-candidate plan', () => {
    // A requestedValue names only one field (here, the model). Combined
    // with a standing user.exactOverride naming the provider, the merged
    // override identifies exactly one descriptor — see buildExactOverride's
    // documentation for why both fields are required to match at all.
    const request = baseRequest({
      requestedValue: { target: 'model', override: openai.model },
    });
    const options = baseOptions(catalogOf([anthropic, openai]), {
      deployment: { deniedModels: [openai.model] },
      user: { exactOverride: { provider: 'openai' } },
    });
    const plan = select(request, options);
    expect(plan.outcome).toBe('exact-override-rejected');
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.eligible).toBe(false);
    expect(plan.candidates[0]?.exclusionCode).toBe('denied-by-deployment');
    expect(plan.failure?.exclusionCode).toBe('denied-by-deployment');
    expect(plan.failure?.rejectedOverride).toEqual(request.requestedValue);
  });

  it('yields no-candidate when a fully specified override matches no descriptor', () => {
    const request = baseRequest({
      requestedValue: { target: 'model', override: 'nonexistent-model' },
    });
    const options = baseOptions(catalogOf([anthropic, openai]), {
      user: { exactOverride: { provider: 'openai' } },
    });
    const plan = select(request, options);
    expect(plan.outcome).toBe('no-candidate');
    expect(plan.candidates).toEqual([]);
  });

  it('selects the exact override when every layer above the user permits it', () => {
    const request = baseRequest({
      requestedValue: { target: 'provider', override: 'openai' },
    });
    const options = baseOptions(catalogOf([anthropic, openai]), {
      user: { exactOverride: { model: openai.model } },
    });
    const plan = select(request, options);
    expect(plan.outcome).toBe('selected');
    expect(plan.selected).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('always yields no-candidate for a route override, since no descriptor carries a route field', () => {
    const request = baseRequest({ requestedValue: { target: 'route', override: 'us-east' } });
    const plan = select(request, baseOptions(catalogOf([anthropic])));
    expect(plan.outcome).toBe('no-candidate');
  });
});

describe('select: unsupported effort — reject versus degrade', () => {
  it('rejects with incompatible-effort when effortFallbackMode is absent (default reject)', () => {
    const request = baseRequest({ requestedValue: { target: 'effort', override: 'xhigh' } });
    const plan = select(request, baseOptions(catalogOf([opus45])));
    expect(plan.outcome).toBe('no-candidate');
    expect(plan.failure?.exclusionCode).toBe('incompatible-effort');
    expect(plan.candidates[0]?.exclusionCode).toBe('incompatible-effort');
  });

  it('rejects with incompatible-effort when effortFallbackMode is explicitly reject', () => {
    const request = baseRequest({ requestedValue: { target: 'effort', override: 'xhigh' } });
    const options = baseOptions(catalogOf([opus45]), { user: { effortFallbackMode: 'reject' } });
    const plan = select(request, options);
    expect(plan.outcome).toBe('no-candidate');
    expect(plan.failure?.exclusionCode).toBe('incompatible-effort');
  });

  it('degrades to the nearest supported lower tier when effortFallbackMode is degrade', () => {
    const request = baseRequest({ requestedValue: { target: 'effort', override: 'xhigh' } });
    const options = baseOptions(catalogOf([opus45]), { user: { effortFallbackMode: 'degrade' } });
    const plan = select(request, options);
    expect(plan.outcome).toBe('selected');
    expect(plan.selected?.effort).toBe(opus45.effort.degradesTo['xhigh']);
    expect(plan.selected?.effort).toBe('high');
    // The requested tier is still visible on the request, unmodified.
    expect(plan.request.requestedValue).toEqual({ target: 'effort', override: 'xhigh' });
  });

  it('rejects even under degrade mode when the tier is unsupported at any degradation', () => {
    const request = baseRequest({ requestedValue: { target: 'effort', override: 'low' } });
    const options = baseOptions(catalogOf([haiku45]), { user: { effortFallbackMode: 'degrade' } });
    const plan = select(request, options);
    expect(plan.outcome).toBe('no-candidate');
    expect(plan.failure?.exclusionCode).toBe('incompatible-effort');
  });

  it('honors a requested effort from user.exactOverride.effort when requestedValue is absent', () => {
    const options = baseOptions(catalogOf([opus45]), {
      user: { exactOverride: { effort: 'max' } },
    });
    const plan = select(baseRequest(), options);
    expect(plan.outcome).toBe('selected');
    expect(plan.selected?.effort).toBe('max');
  });

  it('honors user.defaultEffort when nothing more specific is set', () => {
    const options = baseOptions(catalogOf([anthropic]), { user: { defaultEffort: 'low' } });
    const plan = select(baseRequest(), options);
    expect(plan.outcome).toBe('selected');
    expect(plan.selected?.effort).toBe('low');
  });

  it('leaves selected.effort undefined when no effort is requested at all', () => {
    const plan = select(baseRequest(), baseOptions(catalogOf([anthropic])));
    expect(plan.selected?.effort).toBeUndefined();
  });
});

describe('select: fallbackPlan', () => {
  it('stays empty when fallbackOrder is not configured', () => {
    const plan = select(baseRequest(), baseOptions(catalogOf([anthropic, openai])));
    expect(plan.fallbackPlan).toEqual([]);
  });

  it('populates fallbackPlan in the declared fallbackOrder sequence, intersected with the eligible set', () => {
    const options = baseOptions(catalogOf([anthropic, openai, gemini]), {
      user: { fallbackOrder: [gemini.model, 'nonexistent', openai.model] },
    });
    const plan = select(baseRequest(), options);
    expect(plan.fallbackPlan).toEqual([
      { provider: 'gemini', model: gemini.model },
      { provider: 'openai', model: openai.model },
    ]);
  });

  it('picks the lexicographically smallest provider as the deterministic representative when multiple eligible descriptors share a model name, regardless of catalog order', () => {
    const sharedAnthropic: BackendDescriptor = {
      ...anthropic,
      provider: 'anthropic',
      model: 'shared-model',
      pricing: undefined,
    };
    const sharedOpenAI: BackendDescriptor = {
      ...openai,
      provider: 'openai',
      model: 'shared-model',
      pricing: undefined,
    };
    const options = baseOptions(catalogOf([sharedOpenAI, sharedAnthropic]), {
      user: { fallbackOrder: ['shared-model'] },
    });
    const plan = select(baseRequest(), options);
    expect(plan.fallbackPlan).toEqual([{ provider: 'anthropic', model: 'shared-model' }]);

    const reversedOptions = baseOptions(catalogOf([sharedAnthropic, sharedOpenAI]), {
      user: { fallbackOrder: ['shared-model'] },
    });
    const reversedPlan = select(baseRequest(), reversedOptions);
    expect(reversedPlan.fallbackPlan).toEqual([{ provider: 'anthropic', model: 'shared-model' }]);
  });
});

describe('select: stale-catalog', () => {
  it('marks every candidate without excluding any, and reports outcome stale-catalog', () => {
    const options = baseOptions(catalogOf([anthropic, openai], { stale: true, revision: 7 }));
    const plan = select(baseRequest({ catalogRevision: 7 }), options);
    expect(plan.outcome).toBe('stale-catalog');
    expect(plan.failure?.reason).toContain('7');
    expect(plan.failure?.exclusionCode).toBeUndefined();
    expect(plan.candidates).toHaveLength(2);
    expect(plan.candidates.every((candidate) => candidate.eligible)).toBe(true);
    expect(plan.selected).toBeUndefined();
  });

  it('enumerates the full descriptor set even when a real exactOverride would otherwise narrow to one candidate', () => {
    const request = baseRequest({
      catalogRevision: 7,
      requestedValue: { target: 'model', override: openai.model },
    });
    const options = baseOptions(catalogOf([anthropic, openai], { stale: true, revision: 7 }), {
      user: { exactOverride: { provider: 'openai' } },
    });
    const plan = select(request, options);
    expect(plan.outcome).toBe('stale-catalog');
    expect(plan.candidates).toHaveLength(2);
    expect(plan.candidates.every((candidate) => candidate.eligible)).toBe(true);
  });
});

describe('select: no-candidate with a shared exclusion code', () => {
  it('surfaces the shared exclusionCode when every excluded candidate shares one', () => {
    const options = baseOptions(catalogOf([anthropic, openai]), {
      deployment: { deniedProviders: ['anthropic', 'openai'] },
    });
    const plan = select(baseRequest(), options);
    expect(plan.outcome).toBe('no-candidate');
    expect(plan.failure?.exclusionCode).toBe('denied-by-deployment');
  });

  it('leaves exclusionCode undefined when excluded candidates disagree on the reason', () => {
    const options = baseOptions(catalogOf([anthropic, openai]), {
      deployment: { deniedProviders: ['anthropic'] },
      bureau: { deniedProviders: ['openai'] },
    });
    const plan = select(baseRequest(), options);
    expect(plan.outcome).toBe('no-candidate');
    expect(plan.failure?.exclusionCode).toBeUndefined();
  });
});

describe('select: revalidation', () => {
  it('reports capability-changed when the catalog revision moved and the prior candidate is gone', () => {
    const request = baseRequest({ catalogRevision: 2 });
    const options = baseOptions(catalogOf([openai]), {
      revalidate: {
        priorSelected: { provider: 'anthropic', model: anthropic.model },
        priorCatalogRevision: 1,
        priorPolicyRevision: 1,
      },
    });
    const plan = select(request, options);
    expect(plan.outcome).toBe('capability-changed');
    expect(plan.failure?.reason).toContain('anthropic');
  });

  it('reports policy-changed when the policy revision moved and the prior candidate is now excluded', () => {
    const request = baseRequest({ policyRevision: 2 });
    const options = baseOptions(catalogOf([anthropic, openai]), {
      bureau: { deniedProviders: ['anthropic'] },
      revalidate: {
        priorSelected: { provider: 'anthropic', model: anthropic.model },
        priorCatalogRevision: 1,
        priorPolicyRevision: 1,
      },
    });
    const plan = select(request, options);
    expect(plan.outcome).toBe('policy-changed');
    expect(plan.failure?.exclusionCode).toBe('denied-by-bureau');
  });

  it('proceeds to a normal selection when the prior candidate is still present and eligible', () => {
    const options = baseOptions(catalogOf([anthropic]), {
      revalidate: {
        priorSelected: { provider: 'anthropic', model: anthropic.model },
        priorCatalogRevision: 1,
        priorPolicyRevision: 1,
      },
    });
    const plan = select(baseRequest(), options);
    expect(plan.outcome).toBe('selected');
  });

  it('does not revalidate when catalog and policy revisions are unchanged', () => {
    const options = baseOptions(catalogOf([openai]), {
      revalidate: {
        priorSelected: { provider: 'anthropic', model: anthropic.model },
        priorCatalogRevision: 1,
        priorPolicyRevision: 1,
      },
    });
    const plan = select(baseRequest(), options);
    expect(plan.outcome).toBe('selected');
    expect(plan.selected?.provider).toBe('openai');
  });
});

describe('select: configurationRevision and selectorRevision', () => {
  it('carries configurationRevision through when supplied', () => {
    const options = baseOptions(catalogOf([anthropic]), { configurationRevision: 42 });
    const plan = select(baseRequest(), options);
    expect(plan.configurationRevision).toBe(42);
  });

  it('leaves configurationRevision undefined when not supplied', () => {
    const plan = select(baseRequest(), baseOptions(catalogOf([anthropic])));
    expect(plan.configurationRevision).toBeUndefined();
  });

  it('defaults selectorRevision to 1 and honors an explicit override', () => {
    const defaultPlan = select(baseRequest(), baseOptions(catalogOf([anthropic])));
    expect(defaultPlan.selectorRevision).toBe(1);

    const options = baseOptions(catalogOf([anthropic]), { selectorRevision: 3 });
    const plan = select(baseRequest(), options);
    expect(plan.selectorRevision).toBe(3);
  });
});

describe('select: default now and newPlanId', () => {
  it('uses the wall clock and crypto.randomUUID when now/newPlanId are not injected', () => {
    const plan = select(baseRequest(), { catalog: catalogOf([anthropic]) });
    expect(typeof plan.createdAt).toBe('string');
    expect(new Date(plan.createdAt).toString()).not.toBe('Invalid Date');
    expect(typeof plan.planId).toBe('string');
    expect(plan.planId.length).toBeGreaterThan(0);
  });
});

describe('recordEffectiveGeneration', () => {
  it('leaves a non-diverged plan unchanged, by reference', () => {
    const plan = select(baseRequest(), baseOptions(catalogOf([anthropic])));
    const effective: EffectiveGenerationResult = {
      planId: plan.planId,
      provider: 'anthropic',
      model: 'claude-fable-5',
      divergedFromPlan: false,
    };
    expect(recordEffectiveGeneration(plan, effective)).toBe(plan);
  });

  it('records a divergence as a new terminal plan without rewriting selected', () => {
    const plan = select(baseRequest(), baseOptions(catalogOf([anthropic])));
    const effective: EffectiveGenerationResult = {
      planId: plan.planId,
      provider: 'openai',
      model: 'gpt-4o',
      divergedFromPlan: true,
    };
    const diverged = recordEffectiveGeneration(plan, effective);
    expect(diverged.outcome).toBe('provider-effective-divergence');
    expect(diverged.failure?.kind).toBe('provider-effective-divergence');
    expect(diverged.selected).toEqual(plan.selected);
    expect(plan.outcome).toBe('selected'); // original plan untouched
  });

  it('leaves a non-selected plan unchanged, by reference — there is no completed response to diverge from', () => {
    const plan = select(baseRequest(), baseOptions(catalogOf([])));
    expect(plan.outcome).toBe('no-candidate');
    const effective: EffectiveGenerationResult = {
      planId: plan.planId,
      provider: 'openai',
      model: 'gpt-4o',
      divergedFromPlan: true,
    };
    expect(recordEffectiveGeneration(plan, effective)).toBe(plan);
  });
});

describe('select: exactOverride merges a standing user override with a requestedValue target', () => {
  it('merges a requestedValue provider override onto a standing exactOverride model', () => {
    const request = baseRequest({ requestedValue: { target: 'provider', override: 'anthropic' } });
    const user: UserModelConfiguration = { exactOverride: { model: anthropic.model } };
    const plan = select(request, baseOptions(catalogOf([anthropic, openai]), { user }));
    expect(plan.outcome).toBe('selected');
    expect(plan.selected).toEqual({ provider: 'anthropic', model: 'claude-fable-5' });
  });
});
