/**
 * Bureau's model policy configuration and selection-planning surface
 * (AB-64's decision record; AB-250/mod-03c).
 *
 * `createModelPolicyPlanner` is tested directly against a hand-constructed
 * `ModelCatalogService` (`createModelCatalogService`, AB-246) and plain
 * `createAgent` fixtures — no full `createBureau()` instance is needed for
 * this module's own behavior, matching `model-catalog-refresh.test.ts` and
 * `agent-catalog.test.ts`'s own conventions. `create-bureau.test.ts` covers
 * the `selectorAvailable: true` wiring and `bureau.planSelection` surface.
 *
 * No sleeps, no timers, no network — every timestamp and plan id is
 * injected, and `descriptorSource` is a spy that must never fire.
 */
import { createAgent } from '@lostgradient/operative';
import {
  createModelCatalog,
  type ProviderName,
  withBackendDescriptors,
} from '@lostgradient/operative/providers';
import { createMockGenerate } from '@lostgradient/operative/test';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createModelCatalogService, type ModelCatalogService } from './model-catalog-refresh';
import { createModelPolicyPlanner, type PlanSelectionRequest } from './model-policy';

const FIXED_NOW = '2026-09-03T12:00:00.000Z';
const now = () => FIXED_NOW;
let planIdCounter = 0;
function freshNewPlanId(): () => string {
  planIdCounter = 0;
  return () => `bureau-plan-${String(planIdCounter++).padStart(4, '0')}`;
}

const SEED_CATALOG = createModelCatalog({ now: () => FIXED_NOW });

function requireDescriptor(provider: string) {
  const descriptor = SEED_CATALOG.descriptors.find((row) => row.provider === provider);
  if (!descriptor) throw new Error(`expected at least one seed descriptor for ${provider}`);
  return descriptor;
}

const anthropicDescriptor = requireDescriptor('anthropic');
const geminiDescriptor = requireDescriptor('gemini');

function fixedAgent(name: string) {
  return createAgent({
    generate: withBackendDescriptors(createMockGenerate([]), [anthropicDescriptor]),
    name,
  });
}

function selectableAgent(
  name: string,
  allowedCandidates: readonly { provider: ProviderName; model: string }[] = [
    { provider: geminiDescriptor.provider, model: geminiDescriptor.model },
  ],
) {
  return createAgent({ generate: createMockGenerate([]), name, allowedCandidates });
}

/** A `descriptorSource` counter — `planSelection`/`createSelectionGateFor`
 *  must never trigger a refresh, so this stays at 0 across every test in
 *  this file that reads it. */
function makeMustNeverRefreshCatalogService(): {
  service: ModelCatalogService;
  descriptorSourceCallCount: () => number;
} {
  let calls = 0;
  const service = createModelCatalogService({
    seed: SEED_CATALOG,
    descriptorSource: () => {
      calls++;
      return Promise.resolve(SEED_CATALOG.descriptors);
    },
    now,
    newRefreshId: () => 'refresh-should-not-happen',
  });
  return { service, descriptorSourceCallCount: () => calls };
}

describe('createModelPolicyPlanner: planSelection is side-effect-free', () => {
  it('never invokes the injected descriptorSource', () => {
    const { service, descriptorSourceCallCount } = makeMustNeverRefreshCatalogService();
    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      modelCatalog: service,
      now,
      newPlanId: freshNewPlanId(),
    });

    planner.planSelection({ agentName: 'fixed' });
    planner.planSelection({ agentName: 'fixed' });
    planner.createSelectionGateFor({ agentName: 'fixed' });

    expect(descriptorSourceCallCount()).toBe(0);
  });

  it('does not change the catalog revision', () => {
    const { service } = makeMustNeverRefreshCatalogService();
    const revisionBefore = service.catalog().revision;

    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      modelCatalog: service,
      now,
      newPlanId: freshNewPlanId(),
    });
    planner.planSelection({ agentName: 'fixed' });
    planner.planSelection({ agentName: 'fixed' });

    expect(service.catalog().revision).toBe(revisionBefore);
  });

  it('starts no run and dispatches no event — returns synchronously, not a Promise', () => {
    const { service } = makeMustNeverRefreshCatalogService();
    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      modelCatalog: service,
      now,
      newPlanId: freshNewPlanId(),
    });

    const plan = planner.planSelection({ agentName: 'fixed' });

    expect(plan).not.toBeInstanceOf(Promise);
    expect(plan.outcome).toBe('selected');
  });
});

describe('createModelPolicyPlanner: planSelection', () => {
  it('yields a one-candidate selected plan for a fixed Agent', () => {
    const { service } = makeMustNeverRefreshCatalogService();
    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      modelCatalog: service,
      now,
      newPlanId: freshNewPlanId(),
    });

    const plan = planner.planSelection({ agentName: 'fixed' });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.selected).toEqual({
      provider: anthropicDescriptor.provider,
      model: anthropicDescriptor.model,
    });
  });

  it('narrows candidates to a selectable Agent’s own allowedCandidates', () => {
    const { service } = makeMustNeverRefreshCatalogService();
    const planner = createModelPolicyPlanner({
      agents: {
        selectable: selectableAgent('selectable', [
          { provider: geminiDescriptor.provider, model: geminiDescriptor.model },
        ]),
      } satisfies AgentDefinitions,
      modelCatalog: service,
      now,
      newPlanId: freshNewPlanId(),
    });

    const plan = planner.planSelection({ agentName: 'selectable' });

    expect(plan.candidates.every((candidate) => candidate.provider === 'gemini')).toBe(true);
    expect(plan.selected?.provider).toBe('gemini');
    expect(plan.selected?.model).toBe(geminiDescriptor.model);
  });

  it('applies the per-principal UserModelConfiguration selected by request.principal', () => {
    const { service } = makeMustNeverRefreshCatalogService();
    const planner = createModelPolicyPlanner({
      agents: {
        selectable: selectableAgent('selectable', [
          { provider: geminiDescriptor.provider, model: geminiDescriptor.model },
          { provider: anthropicDescriptor.provider, model: anthropicDescriptor.model },
        ]),
      } satisfies AgentDefinitions,
      modelCatalog: service,
      modelPolicy: {
        policyRevision: 1,
        users: {
          // With no preference set, both candidates tie at the same rank
          // score and `select` breaks the tie lexicographically by
          // `(provider, model)` — 'anthropic' sorts before 'gemini', so
          // that's the default winner. Denying it forces the switch, which
          // is the observable proof `principal` actually changed the plan.
          'user-a': { deniedProviders: ['anthropic'] },
        },
      },
      now,
      newPlanId: freshNewPlanId(),
    });

    const withoutPrincipal = planner.planSelection({ agentName: 'selectable' });
    expect(withoutPrincipal.selected?.provider).toBe('anthropic');

    const withPrincipal: PlanSelectionRequest = { agentName: 'selectable', principal: 'user-a' };
    const withPrincipalPlan = planner.planSelection(withPrincipal);
    expect(withPrincipalPlan.selected?.provider).toBe('gemini');
  });

  it('composes with no user layer when request.principal is absent', () => {
    const { service } = makeMustNeverRefreshCatalogService();
    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      modelCatalog: service,
      modelPolicy: {
        policyRevision: 1,
        users: { 'user-a': { deniedProviders: ['anthropic'] } },
      },
      now,
      newPlanId: freshNewPlanId(),
    });

    const plan = planner.planSelection({ agentName: 'fixed' });
    expect(plan.outcome).toBe('selected');
    expect(plan.selected?.provider).toBe('anthropic');
  });

  it('stamps every plan with modelPolicy.policyRevision', () => {
    const { service } = makeMustNeverRefreshCatalogService();
    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      modelCatalog: service,
      modelPolicy: { policyRevision: 7 },
      now,
      newPlanId: freshNewPlanId(),
    });

    expect(planner.planSelection({ agentName: 'fixed' }).policyRevision).toBe(7);
  });
});

describe('createModelPolicyPlanner: createSelectionGateFor', () => {
  it('builds a gate seeded with planSelection’s own plan', () => {
    const { service } = makeMustNeverRefreshCatalogService();
    const planner = createModelPolicyPlanner({
      agents: { fixed: fixedAgent('fixed') } satisfies AgentDefinitions,
      modelCatalog: service,
      now,
      newPlanId: freshNewPlanId(),
    });

    const gate = planner.createSelectionGateFor({ agentName: 'fixed' });

    expect(gate.getPlan()?.outcome).toBe('selected');
    expect(gate.getPlan()?.selected?.provider).toBe('anthropic');
  });

  it('revalidate() reflects Bureau’s live catalog after a commit — a selectable Agent draws from Bureau’s catalog, unlike a fixed Agent’s own attached descriptor', () => {
    const { service } = makeMustNeverRefreshCatalogService();
    const planner = createModelPolicyPlanner({
      agents: {
        selectable: selectableAgent('selectable', [
          { provider: geminiDescriptor.provider, model: geminiDescriptor.model },
        ]),
      } satisfies AgentDefinitions,
      modelCatalog: service,
      now,
      newPlanId: freshNewPlanId(),
    });

    const gate = planner.createSelectionGateFor({ agentName: 'selectable' });
    expect(gate.getPlan()?.outcome).toBe('selected');
    expect(gate.getPlan()?.selected?.provider).toBe('gemini');

    // Bureau's catalog moves on — the gemini descriptor is dropped
    // entirely via the synchronous operator-override commit path
    // (`ModelCatalogService.replaceCatalog`, AB-246).
    service.replaceCatalog(
      service.catalog().descriptors.filter((descriptor) => descriptor.provider !== 'gemini'),
    );

    const revalidated = gate.revalidate();
    expect(revalidated.outcome).not.toBe('selected');
  });
});
