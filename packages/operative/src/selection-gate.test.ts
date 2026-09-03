/**
 * `SelectionGate`/`createSelectionGate` (AB-64's decision record; AB-250).
 *
 * `select` (AB-249) is pure and already implements the revalidation
 * comparison this gate wraps — these tests exercise the GATE's own added
 * behavior: the no-op fast path when nothing has changed, delegating to
 * `select`'s `options.revalidate` branch when the catalog or policy
 * revision moved, falling through to `select`'s ordinary zero-candidate
 * path when only `availabilitySnapshotRevision` moved, and keeping
 * `getPlan()` in sync with the latest `revalidate()` result without ever
 * mutating a superseded plan.
 *
 * No sleeps, no timers, no network — every timestamp and plan id is
 * injected via `now`/`newPlanId`, matching `providers/selection.test.ts`'s
 * own convention.
 */
import { describe, expect, it } from 'bun:test';

import {
  type BackendDescriptor,
  createModelCatalog,
  type ModelCatalog,
} from './providers/model-catalog.ts';
import { createSelectionGate, type SelectionGate } from './selection-gate.ts';

const FIXED_NOW = '2026-09-02T12:00:00.000Z';
const now = () => FIXED_NOW;

let planIdCounter = 0;
function freshNewPlanId(): () => string {
  planIdCounter = 0;
  return () => `gate-plan-${String(planIdCounter++).padStart(4, '0')}`;
}

const SEED_CATALOG = createModelCatalog({ now: () => FIXED_NOW });

function descriptor(provider: string, model: string): BackendDescriptor {
  const found = SEED_CATALOG.descriptors.find(
    (row) => row.provider === provider && row.model === model,
  );
  if (found === undefined) throw new Error(`fixture descriptor not found: ${provider}/${model}`);
  return found;
}

const anthropic = descriptor('anthropic', 'claude-fable-5');

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

/**
 * A controllable source: `catalog`/`policyRevision`/`availabilitySnapshotRevision`
 * are mutable test-local state the returned closures read fresh on every
 * call, exactly as a real Bureau-backed source would read its own live
 * `ModelCatalogService.catalog()` and policy configuration.
 */
function makeGate(initialCatalog: ModelCatalog): {
  gate: SelectionGate;
  setCatalog: (catalog: ModelCatalog) => void;
  setPolicyRevision: (revision: number) => void;
  setAvailabilitySnapshotRevision: (revision: number) => void;
} {
  let catalog = initialCatalog;
  let policyRevision = 1;
  let availabilitySnapshotRevision = initialCatalog.revision;

  const gate = createSelectionGate({
    request: () => ({
      agentName: 'test-agent',
      catalogRevision: catalog.revision,
      policyRevision,
      availabilitySnapshotRevision,
    }),
    options: () => ({ catalog, now, newPlanId: freshNewPlanId() }),
  });

  return {
    gate,
    setCatalog: (next) => {
      catalog = next;
    },
    setPolicyRevision: (next) => {
      policyRevision = next;
    },
    setAvailabilitySnapshotRevision: (next) => {
      availabilitySnapshotRevision = next;
    },
  };
}

describe('createSelectionGate: getPlan()', () => {
  it('returns undefined before any selection has been recorded', () => {
    const { gate } = makeGate(catalogOf([anthropic]));
    expect(gate.getPlan()).toBeUndefined();
  });

  it('returns the initialPlan supplied at construction, unchanged, before revalidate() is called', () => {
    const initialPlan = createSelectionGate({
      request: () => ({
        agentName: 'test-agent',
        catalogRevision: 1,
        policyRevision: 1,
        availabilitySnapshotRevision: 1,
      }),
      options: () => ({ catalog: catalogOf([anthropic]), now, newPlanId: freshNewPlanId() }),
    }).revalidate();

    const gate = createSelectionGate({
      initialPlan,
      request: () => ({
        agentName: 'test-agent',
        catalogRevision: 1,
        policyRevision: 1,
        availabilitySnapshotRevision: 1,
      }),
      options: () => ({ catalog: catalogOf([anthropic]), now, newPlanId: freshNewPlanId() }),
    });

    expect(gate.getPlan()).toBe(initialPlan);
  });

  it('reflects the latest revalidate() result after it is called', () => {
    const { gate } = makeGate(catalogOf([anthropic]));
    const plan = gate.revalidate();
    expect(gate.getPlan()).toBe(plan);
  });
});

describe('createSelectionGate: revalidate() with no recorded plan', () => {
  it('performs a plain first selection, synchronously, without a revalidate comparison', () => {
    const { gate } = makeGate(catalogOf([anthropic]));
    const plan = gate.revalidate();
    expect(plan).not.toBeInstanceOf(Promise);
    expect(plan.outcome).toBe('selected');
    expect(plan.selected).toEqual({ provider: 'anthropic', model: 'claude-fable-5' });
  });
});

describe('createSelectionGate: revalidate() no-op fast path', () => {
  it('returns the SAME plan object by reference when nothing recorded has changed', () => {
    const { gate } = makeGate(catalogOf([anthropic]));
    const first = gate.revalidate();
    const second = gate.revalidate();
    expect(second).toBe(first);
  });
});

describe('createSelectionGate: catalog revision changed', () => {
  it('reports capability-changed when the prior selected candidate is no longer eligible under the new catalog', () => {
    const { gate, setCatalog } = makeGate(catalogOf([anthropic], { revision: 1 }));
    const first = gate.revalidate();
    expect(first.outcome).toBe('selected');

    // A new catalog revision with the prior winner removed entirely.
    setCatalog(catalogOf([], { revision: 2 }));
    const second = gate.revalidate();

    expect(second.outcome).toBe('capability-changed');
    expect(second.failure?.kind).toBe('capability-changed');
    // The superseded plan is untouched — its `selected` is never rewritten.
    expect(first.selected).toEqual({ provider: 'anthropic', model: 'claude-fable-5' });
    expect(gate.getPlan()).toBe(second);
  });

  it('re-selects normally (outcome selected) when the catalog revision changed but the prior candidate is still eligible', () => {
    const { gate, setCatalog } = makeGate(catalogOf([anthropic], { revision: 1 }));
    const first = gate.revalidate();

    setCatalog(catalogOf([anthropic], { revision: 2 }));
    const second = gate.revalidate();

    expect(second.outcome).toBe('selected');
    expect(second.catalogRevision).toBe(2);
    expect(second).not.toBe(first);
  });
});

describe('createSelectionGate: policy revision changed', () => {
  it('reports policy-changed when the prior selected candidate is no longer eligible under the new policy', () => {
    const { gate, setPolicyRevision } = makeGate(catalogOf([anthropic]));
    const first = gate.revalidate();
    expect(first.outcome).toBe('selected');

    setPolicyRevision(2);
    // No catalog change, so the ONLY way the candidate can become
    // ineligible here is a policy layer excluding it — simulated by
    // wrapping the gate's options with a deployment denial keyed off the
    // new policy revision.
    const gateWithPolicyDenial = createSelectionGate({
      initialPlan: first,
      request: () => ({
        agentName: 'test-agent',
        catalogRevision: 1,
        policyRevision: 2,
        availabilitySnapshotRevision: 1,
      }),
      options: () => ({
        catalog: catalogOf([anthropic]),
        deployment: { deniedProviders: ['anthropic'] },
        now,
        newPlanId: freshNewPlanId(),
      }),
    });

    const second = gateWithPolicyDenial.revalidate();

    expect(second.outcome).toBe('policy-changed');
    expect(second.failure?.kind).toBe('policy-changed');
    expect(first.selected).toEqual({ provider: 'anthropic', model: 'claude-fable-5' });
  });
});

describe('createSelectionGate: availability-only change', () => {
  it('falls through to no-candidate — not capability-changed — when only availabilitySnapshotRevision moved', () => {
    const { gate, setAvailabilitySnapshotRevision } = makeGate(catalogOf([anthropic]));
    const first = gate.revalidate();
    expect(first.outcome).toBe('selected');

    // The catalog and policy revisions are UNCHANGED; only the
    // availability snapshot moved, and the gate's `options()` source now
    // reports the sole candidate as unavailable — the "a run whose only
    // candidate becomes availability: 'unavailable' between plan and
    // boundary" scenario AB-250's acceptance criteria name.
    setAvailabilitySnapshotRevision(2);
    const unavailableAnthropic: BackendDescriptor = { ...anthropic, availability: 'unavailable' };
    const gateWithUnavailableCandidate = createSelectionGate({
      initialPlan: first,
      request: () => ({
        agentName: 'test-agent',
        catalogRevision: 1,
        policyRevision: 1,
        availabilitySnapshotRevision: 2,
      }),
      options: () => ({
        catalog: catalogOf([unavailableAnthropic]),
        now,
        newPlanId: freshNewPlanId(),
      }),
    });

    const second = gateWithUnavailableCandidate.revalidate();

    expect(second.outcome).toBe('no-candidate');
    expect(second.failure?.kind).toBe('no-candidate');
    // Never silently falls back to the superseded plan's model.
    expect(second.selected).toBeUndefined();
    expect(first.selected).toEqual({ provider: 'anthropic', model: 'claude-fable-5' });
  });
});
