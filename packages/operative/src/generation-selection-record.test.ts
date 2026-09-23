/**
 * `composeGenerationSelectionRecord` (AB-68) — the record `generate.started`
 * carries about the configuration one generation is issued under.
 *
 * The function is pure and synchronous: no sleeps, no timers, no network,
 * no provider call. Every input here is a literal, so each assertion names
 * exactly the plan/steering pair it is about.
 */
import { describe, expect, it } from 'bun:test';

import type { SteeringDesiredState } from './durable/types.ts';
import { composeGenerationSelectionRecord } from './generation-selection-record.ts';
import type { SelectionPlan, SelectionRequest } from './providers/selection.ts';

const REQUEST: SelectionRequest = {
  agentName: 'writer',
  catalogRevision: 1,
  policyRevision: 1,
  availabilitySnapshotRevision: 1,
};

function selectedPlan(
  selected: { provider: string; model: string; route?: string; effort?: 'low' | 'high' },
  fallbackPlan: readonly { provider: string; model: string; route?: string }[] = [],
): SelectionPlan {
  return {
    planId: 'plan-1',
    request: REQUEST,
    candidates: [],
    selected,
    fallbackPlan,
    catalogRevision: 1,
    policyRevision: 1,
    selectorRevision: 1,
    createdAt: '2026-09-19T00:00:00.000Z',
    outcome: 'selected',
  } as SelectionPlan;
}

function unselectedPlan(): SelectionPlan {
  return {
    planId: 'plan-2',
    request: REQUEST,
    candidates: [],
    fallbackPlan: [],
    catalogRevision: 1,
    policyRevision: 1,
    selectorRevision: 1,
    createdAt: '2026-09-19T00:00:00.000Z',
    outcome: 'no-candidate',
    failure: { kind: 'no-candidate', reason: 'nothing eligible' },
  } as unknown as SelectionPlan;
}

function steering(overrides: Partial<SteeringDesiredState> = {}): SteeringDesiredState {
  return { paused: false, configVersion: 3, ...overrides };
}

describe('composeGenerationSelectionRecord', () => {
  it('returns undefined when the run has neither gate', () => {
    // An unconfigured run knows none of these coordinates. An all-undefined
    // record would be indistinguishable from one whose fields genuinely
    // resolved to nothing, so the honest answer is no record at all.
    expect(composeGenerationSelectionRecord(undefined, undefined)).toBeUndefined();
  });

  it('reports the plan selection as both selected and effective when nothing steers', () => {
    const record = composeGenerationSelectionRecord(
      selectedPlan({ provider: 'anthropic', model: 'claude-opus-5', effort: 'high' }),
      undefined,
    );

    expect(record?.planId).toBe('plan-1');
    expect(record?.planOutcome).toBe('selected');
    expect(record?.selected).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      route: undefined,
      effort: 'high',
    });
    expect(record?.effective).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      route: undefined,
      effort: 'high',
    });
    expect(record?.divergence).toEqual([]);
    expect(record?.configVersion).toBeUndefined();
  });

  it('layers steering over the plan field by field and reports only the fields that moved', () => {
    // The regression this guards: a command steering only `effort` must not
    // discard the plan's provider and model.
    const record = composeGenerationSelectionRecord(
      selectedPlan({ provider: 'anthropic', model: 'claude-opus-5', effort: 'high' }),
      steering({ effort: 'low' }),
    );

    expect(record?.effective).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      route: undefined,
      effort: 'low',
    });
    expect(record?.divergence).toEqual([
      { field: 'effort', reason: 'steering-override', planned: 'high', effective: 'low' },
    ]);
    expect(record?.configVersion).toBe(3);
  });

  it('records one divergence entry per moved field, in a fixed order', () => {
    const record = composeGenerationSelectionRecord(
      selectedPlan({ provider: 'anthropic', model: 'claude-opus-5', route: 'primary' }),
      steering({ provider: 'openai', model: 'gpt-5', route: 'secondary' }),
    );

    // Fixed order (provider, model, route, effort) so two records built from
    // the same inputs compare byte-for-byte.
    expect(record?.divergence.map((entry) => entry.field)).toEqual(['provider', 'model', 'route']);
  });

  it('reports no divergence when steering asks for what the plan already chose', () => {
    const record = composeGenerationSelectionRecord(
      selectedPlan({ provider: 'anthropic', model: 'claude-opus-5' }),
      steering({ model: 'claude-opus-5' }),
    );

    expect(record?.divergence).toEqual([]);
  });

  it('reports no divergence when the plan selected nothing, even though steering set fields', () => {
    // There is nothing to diverge FROM. Reporting every steered field here
    // would turn "this run's selector found no candidate" into a wall of
    // false divergence.
    const record = composeGenerationSelectionRecord(
      unselectedPlan(),
      steering({ model: 'claude-opus-5' }),
    );

    expect(record?.planOutcome).toBe('no-candidate');
    expect(record?.selected).toBeUndefined();
    expect(record?.effective.model).toBe('claude-opus-5');
    expect(record?.divergence).toEqual([]);
  });

  it('carries steering alone when the run has no selection gate', () => {
    const record = composeGenerationSelectionRecord(undefined, steering({ effort: 'low' }));

    expect(record?.planId).toBeUndefined();
    expect(record?.planOutcome).toBeUndefined();
    expect(record?.selected).toBeUndefined();
    expect(record?.effective.effort).toBe('low');
    expect(record?.configVersion).toBe(3);
    expect(record?.fallbackPlan).toEqual([]);
  });

  it('carries the plan-authorized fallback order', () => {
    const record = composeGenerationSelectionRecord(
      selectedPlan({ provider: 'anthropic', model: 'claude-opus-5' }, [
        { provider: 'openai', model: 'gpt-5' },
        { provider: 'google', model: 'gemini-3', route: 'eu' },
      ]),
      undefined,
    );

    expect(record?.fallbackPlan).toEqual([
      { provider: 'openai', model: 'gpt-5', route: undefined },
      { provider: 'google', model: 'gemini-3', route: 'eu' },
    ]);
  });

  it('treats a paused steering state as a record-worthy configuration', () => {
    // `paused` is not a backend coordinate, so it contributes no divergence
    // — but its presence still means the run HAS a steering gate, and the
    // configVersion has to be reported.
    const record = composeGenerationSelectionRecord(undefined, steering({ paused: true }));

    expect(record).toBeDefined();
    expect(record?.configVersion).toBe(3);
    expect(record?.divergence).toEqual([]);
  });
});
