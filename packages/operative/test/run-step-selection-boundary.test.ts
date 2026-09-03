/**
 * `runStep`'s AB-64/AB-250 selection-revalidation boundary: `RunOptions.selection`
 * (a `SelectionGate`) is read once per step, at the same shared entry point
 * as the AB-67 steering boundary — after the pause-wait loop, before
 * backpressure. See `run-step.ts`'s boundary comment and
 * `src/run-step.test.ts` for the sibling steering-boundary coverage this
 * file mirrors.
 *
 * These tests drive `runStep` through the in-memory `executeLoop` driver
 * (`buildStepDeps` + the step `for` loop) — the same construction site the
 * durable driver shares. No real timers; no network; every catalog
 * timestamp and plan id is injected.
 */
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from '../src/conditions/predicates';
import { SelectionRevalidationError } from '../src/errors';
import { executeLoop } from '../src/loop';
import {
  type BackendDescriptor,
  createModelCatalog,
  type ModelCatalog,
} from '../src/providers/model-catalog.ts';
import { select, type SelectionRequest, type SelectOptions } from '../src/providers/selection.ts';
import { createSelectionGate, type SelectionGate } from '../src/selection-gate';
import type { GenerateResponse } from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

const FIXED_NOW = '2026-09-02T12:00:00.000Z';
const now = () => FIXED_NOW;
let planIdCounter = 0;
function freshNewPlanId(): () => string {
  planIdCounter = 0;
  return () => `boundary-plan-${String(planIdCounter++).padStart(4, '0')}`;
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
 * A controllable `SelectionGate` source, mirroring `src/selection-gate.test.ts`'s
 * `makeGate`: mutable test-local catalog/policy/availability state the
 * gate's closures read fresh on every `revalidate()` call.
 */
function makeSelectionGateWithCatalog(initialCatalog: ModelCatalog): {
  gate: SelectionGate;
  setCatalog: (catalog: ModelCatalog) => void;
  setAvailabilitySnapshotRevision: (revision: number) => void;
} {
  let catalog = initialCatalog;
  let availabilitySnapshotRevision = initialCatalog.revision;
  const gate = createSelectionGate({
    request: (): SelectionRequest => ({
      agentName: 'test-agent',
      catalogRevision: catalog.revision,
      policyRevision: 1,
      availabilitySnapshotRevision,
    }),
    options: (): SelectOptions => ({ catalog, now, newPlanId: freshNewPlanId() }),
  });
  return {
    gate,
    setCatalog: (next) => {
      catalog = next;
    },
    setAvailabilitySnapshotRevision: (next) => {
      availabilitySnapshotRevision = next;
    },
  };
}

describe('runStep: AB-64/AB-250 selection boundary read', () => {
  it('a run with no selection dependency proceeds exactly as it does today', async () => {
    let generateCalls = 0;

    const result = await executeLoop({
      generate: async () => {
        generateCalls++;
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    expect(generateCalls).toBe(1);
    expect(result.finishReason).toBe('stop-condition');
  });

  it('proceeds normally when revalidate() reports the plan is still selected', async () => {
    const { gate } = makeSelectionGateWithCatalog(catalogOf([anthropic]));
    gate.revalidate(); // seed the gate's recorded plan, as a real Bureau caller's earlier planSelection() would

    let generateCalls = 0;
    const result = await executeLoop({
      generate: async () => {
        generateCalls++;
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      selection: gate,
    });

    expect(generateCalls).toBe(1);
    expect(result.finishReason).toBe('stop-condition');
    expect(gate.getPlan()?.outcome).toBe('selected');
  });

  it('fails the step with a typed SelectionRevalidationError when the only candidate becomes unavailable between plan and boundary', async () => {
    const { gate, setCatalog, setAvailabilitySnapshotRevision } = makeSelectionGateWithCatalog(
      catalogOf([anthropic]),
    );
    const priorPlan = gate.revalidate();
    expect(priorPlan.outcome).toBe('selected');

    // Between planning and this step's boundary read, the sole candidate's
    // availability flips — the exact AB-250 acceptance scenario. The
    // catalog's own structural `revision` is UNCHANGED; only the
    // availability snapshot moved (see `selection-gate.ts`'s doc comment on
    // why this is the `no-candidate`, not `capability-changed`, path).
    const unavailableAnthropic: BackendDescriptor = { ...anthropic, availability: 'unavailable' };
    setCatalog(catalogOf([unavailableAnthropic]));
    setAvailabilitySnapshotRevision(2);

    let generateCalls = 0;
    const result = await executeLoop({
      generate: async () => {
        generateCalls++;
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      selection: gate,
    });

    // The step never reaches generate — it fails outright rather than
    // silently reusing the stale (now-unavailable) model.
    expect(generateCalls).toBe(0);
    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(SelectionRevalidationError);

    const error = result.error as SelectionRevalidationError;
    expect(error.plan.outcome).toBe('no-candidate');
    expect(error.supersededPlan).toBe(priorPlan);
    expect(error.supersededPlan?.selected).toEqual({
      provider: 'anthropic',
      model: 'claude-fable-5',
    });
  });

  it('fails the step with capability-changed when the catalog revision changes and the prior candidate is gone', async () => {
    const { gate, setCatalog } = makeSelectionGateWithCatalog(
      catalogOf([anthropic], { revision: 1 }),
    );
    gate.revalidate();

    setCatalog(catalogOf([], { revision: 2 }));

    const result = await executeLoop({
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      selection: gate,
    });

    expect(result.finishReason).toBe('error');
    const error = result.error as SelectionRevalidationError;
    expect(error.plan.outcome).toBe('capability-changed');
  });

  it('never applies a replacement plan to the failing step’s own generate call', async () => {
    // Directly constructs a plan-supersession pair via `select` to confirm
    // the boundary's error carries both plans without mutating either —
    // `SelectionPlan.selected` is never rewritten (AB-64's decision record).
    const selected = select(
      {
        agentName: 'test-agent',
        catalogRevision: 1,
        policyRevision: 1,
        availabilitySnapshotRevision: 1,
      },
      { catalog: catalogOf([anthropic]), now, newPlanId: freshNewPlanId() },
    );
    expect(selected.outcome).toBe('selected');

    const { gate, setCatalog, setAvailabilitySnapshotRevision } = makeSelectionGateWithCatalog(
      catalogOf([anthropic]),
    );
    const priorPlan = gate.revalidate();
    setCatalog(catalogOf([{ ...anthropic, availability: 'unavailable' }]));
    setAvailabilitySnapshotRevision(2);

    let generateCallCount = 0;
    await executeLoop({
      generate: async () => {
        generateCallCount++;
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      selection: gate,
    });

    expect(generateCallCount).toBe(0);
    expect(priorPlan.selected).toEqual({ provider: 'anthropic', model: 'claude-fable-5' });
  });
});
