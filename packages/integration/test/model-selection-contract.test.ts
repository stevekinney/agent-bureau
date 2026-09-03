/**
 * The cross-mode selection-plan replay and attenuation contract suite over
 * the merged AB-249 (`select`/`SelectionPlan`) and AB-250 (`SelectionGate`,
 * `Bureau.planSelection`, delegated-child attenuation) surfaces (AB-64's
 * decision record; AB-251/mod-03d).
 *
 * ONE fixture — a fixed catalog revision, policy revision, availability
 * snapshot revision, task classification, and requested value, over a
 * single eligible `anthropic` descriptor — is driven through five different
 * entry points and normalized (via {@link normalizePlan}, which strips only
 * `planId`/`createdAt`) into a comparable decision record:
 *
 * 1. A direct `createAgent` Agent with a `'fixed'` generation profile,
 *    selected against its own resolved descriptor/preferences.
 * 2. A Bureau `planSelection` call, wired through `createBureau` with a
 *    `modelPolicy` and a hand-seeded `ModelCatalogService`.
 * 3. A child dispatched through `dispatchChildRun` — the lower-level
 *    primitive `createSubagentTool`'s own `execute` calls verbatim (see
 *    `create-subagent-tool.ts`) — with an UNATTENUATED delegated-authority
 *    grant. `createSubagentTool` itself does not yet thread
 *    `delegatedAuthority` into that call (`model-policy.ts`'s own module
 *    docs: wiring `RunOptions.selection`/delegated authority automatically
 *    into every dispatch "is a later issue's to make") — a documented,
 *    intentional gap this fixtures-only issue must not close. This suite
 *    therefore supplies the grant directly to the SAME primitive
 *    `createSubagentTool` calls, exercising the real
 *    `attenuateDelegatedAuthority`/`dispatchChildRun` forwarding path
 *    AB-250's own `child-run.test.ts` validates, then computes the child's
 *    own decision record via `select()` with the CAPTURED, forwarded grant
 *    — never a value recomputed independently of the real dispatch.
 * 4. A durable recovery driven through `createDurableMultiAgentHarness` and
 *    `createManualCheckpointStore` (both from
 *    `@lostgradient/operative/test`): a custom `runWorkflow` built from a
 *    checkpoint store derived from `createManualCheckpointStore()` (spied,
 *    so at least one checkpoint save is observed — the rollback-trigger
 *    guard against a mode that silently never reaches a checkpoint) is
 *    registered on the harness, and a real durable `agentRun` workflow runs
 *    to completion with `RunOptions.selection` wired to the fixture's gate.
 * 5. A historical replay: the fixture's plan is JSON-round-tripped (the
 *    concrete stand-in for "persisted, then reloaded in a later process"),
 *    then the live catalog is advanced — the selected descriptor's row is
 *    removed ENTIRELY — and the replayed value still reports the original
 *    `selected` and per-candidate eligibility reasoning, while a FRESH
 *    `select()` call against the advanced catalog does not.
 *
 * A sixth, separate case proves attenuation is VISIBLE rather than
 * equal: over a two-candidate catalog (`anthropic`, `gemini`), a child
 * dispatched with an unattenuated grant (permits both) is compared against
 * one dispatched with an attenuated grant (permits only `anthropic`) — the
 * two normalized records differ only in the excluded `gemini` candidate and
 * its `exceeds-delegated-authority` code.
 *
 * No test reads the wall clock, calls `Bun.setSystemTime`, sleeps, retries,
 * or raises a timeout — every timestamp and plan id is injected, and the
 * durable mode drives Weft's portable event loop via
 * `yieldToPortableEventLoop`-backed helpers, never a real timer.
 */
import type { AgentInput, AgentRunContext, RunnableAgent } from '@lostgradient/operative';
import * as operative from '@lostgradient/operative';
import { noToolCalls } from '@lostgradient/operative/conditions';
import type { CheckpointStore, DurableRunDeps } from '@lostgradient/operative/durable';
import { createRunWorkflow } from '@lostgradient/operative/durable';
import type {
  BackendDescriptor,
  DelegatedAuthority,
  ModelCatalog,
  SelectionPlan,
  SelectionRequest,
  SelectOptions,
} from '@lostgradient/operative/providers';
import {
  createModelCatalog,
  select,
  withBackendDescriptors,
} from '@lostgradient/operative/providers';
import { createManualCheckpointStore, createMockGenerate } from '@lostgradient/operative/test';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createBureau, createModelCatalogService } from 'bureau';
import { createConversationHistory } from 'conversationalist';

// ── Shared fixture ─────────────────────────────────────────────────────────

const FIXED_NOW = '2026-09-03T12:00:00.000Z';
const now = () => FIXED_NOW;
let planIdCounter = 0;
function freshNewPlanId(): () => string {
  planIdCounter = 0;
  return () => `contract-plan-${String(planIdCounter++).padStart(4, '0')}`;
}

const CATALOG_REVISION = 9;
const POLICY_REVISION = 4;
const AVAILABILITY_REVISION = 9;
const AGENT_NAME = 'contract-agent';
const TASK_CLASSIFICATION = 'contract-suite';
const REQUESTED_VALUE = { target: 'effort', override: 'low' } as const;

const SEED_CATALOG = createModelCatalog({ now: () => FIXED_NOW });

function requireDescriptor(provider: string, model: string): BackendDescriptor {
  const found = SEED_CATALOG.descriptors.find(
    (row) => row.provider === provider && row.model === model,
  );
  if (found === undefined) throw new Error(`fixture descriptor not found: ${provider}/${model}`);
  return found;
}

const anthropic = requireDescriptor('anthropic', 'claude-fable-5');
const gemini = requireDescriptor('gemini', 'gemini-2.5-pro');

function fixtureCatalog(
  descriptors: readonly BackendDescriptor[],
  overrides: Partial<ModelCatalog> = {},
): ModelCatalog {
  return {
    revision: CATALOG_REVISION,
    descriptors,
    generatedAt: FIXED_NOW,
    stale: false,
    projection: 'privileged',
    ...overrides,
  };
}

function fixtureRequest(overrides: Partial<SelectionRequest> = {}): SelectionRequest {
  return {
    agentName: AGENT_NAME,
    taskClassification: TASK_CLASSIFICATION,
    requestedValue: REQUESTED_VALUE,
    catalogRevision: CATALOG_REVISION,
    policyRevision: POLICY_REVISION,
    availabilitySnapshotRevision: AVAILABILITY_REVISION,
    ...overrides,
  };
}

/**
 * Normalizes a `SelectionPlan` into a comparable decision record.
 * AB-251's acceptance criteria: strips ONLY `planId` and `createdAt`; every
 * other field — including the entire nested `request` — participates.
 */
function normalizePlan(plan: SelectionPlan): Omit<SelectionPlan, 'planId' | 'createdAt'> {
  const { planId: _planId, createdAt: _createdAt, ...rest } = plan;
  return rest;
}

function textResponse(content: string) {
  return { content, toolCalls: [] };
}

// ── Mode 1: a direct createAgent Agent with a fixed profile ────────────────

function buildFixedAgent(descriptors: readonly BackendDescriptor[] = [anthropic]) {
  return operative.createAgent({
    generate: withBackendDescriptors(createMockGenerate([textResponse('done')]), descriptors),
    name: AGENT_NAME,
  });
}

function computeMode1Plan(): SelectionPlan {
  const agent = buildFixedAgent();
  const profile = operative.readGenerationProfile(agent);
  expect(profile.mode).toBe('fixed');

  return select(fixtureRequest(), {
    catalog: fixtureCatalog(profile.descriptors),
    ...(profile.preferences ? { agent: profile.preferences } : {}),
    now,
    newPlanId: freshNewPlanId(),
  });
}

// ── Mode 2: a Bureau planSelection call ─────────────────────────────────────

async function computeMode2Plan(): Promise<SelectionPlan> {
  const modelCatalog = createModelCatalogService({
    seed: fixtureCatalog([anthropic]),
    descriptorSource: () => Promise.reject(new Error('descriptorSource must never be invoked')),
    now,
    newRefreshId: () => 'contract-refresh-should-not-happen',
  });

  const bureau = await createBureau({
    agents: { [AGENT_NAME]: buildFixedAgent() },
    modelCatalog,
    modelPolicy: { policyRevision: POLICY_REVISION },
  });

  try {
    return bureau.planSelection({
      agentName: AGENT_NAME,
      taskClassification: TASK_CLASSIFICATION,
      requestedValue: REQUESTED_VALUE,
    });
  } finally {
    await bureau.dispose();
  }
}

// ── Mode 3 / attenuation case: dispatchChildRun (createSubagentTool's own
// dispatch primitive) with delegated authority ─────────────────────────────

/** A trivial `RunnableAgent` that records the `AgentRunContext` it was
 *  dispatched with — including the forwarded `delegatedAuthority` — and
 *  completes immediately. Used to prove `dispatchChildRun` (the exact
 *  primitive `createSubagentTool.execute` calls) really forwards a supplied
 *  `delegatedAuthority` grant onto `AgentRunContext`, rather than assuming it. */
function makeCapturingChildAgent(): {
  agent: RunnableAgent;
  capturedContext: () => AgentRunContext | undefined;
} {
  let capturedContext: AgentRunContext | undefined;
  const generate = createMockGenerate([textResponse('child done')]);
  const inner = operative.createAgent({ generate, name: 'contract-child' });
  const agent: RunnableAgent = {
    name: inner.name,
    hasOutput: inner.hasOutput,
    generationProfile: inner.generationProfile,
    run(input: AgentInput, context?: AgentRunContext) {
      capturedContext = context;
      return inner.run(input, context);
    },
  };
  return { agent, capturedContext: () => capturedContext };
}

async function dispatchChildAndCapturePlan(
  catalog: ModelCatalog,
  grant: DelegatedAuthority | undefined,
  request: SelectionRequest = fixtureRequest(),
): Promise<SelectionPlan> {
  const { agent, capturedContext } = makeCapturingChildAgent();
  const handle = operative.dispatchChildRun(agent, 'run the fixture task', {
    agentName: 'contract-child',
    parentRunId: 'contract-parent-run',
    ...(grant === undefined ? {} : { delegatedAuthority: grant }),
  });
  const result = await handle.result();
  expect(result.finishReason).toBe('stop-condition');

  const forwardedGrant = capturedContext()?.delegatedAuthority;
  return select(request, {
    catalog,
    ...(forwardedGrant === undefined ? {} : { delegated: forwardedGrant }),
    now,
    newPlanId: freshNewPlanId(),
  });
}

// ── Mode 4: durable recovery through createDurableMultiAgentHarness +
// createManualCheckpointStore ───────────────────────────────────────────────

function spiedManualCheckpointStore(): { store: CheckpointStore; checkpointCount: () => number } {
  const base = createManualCheckpointStore();
  let count = 0;
  const store: CheckpointStore = {
    ...base,
    saveCursor: async (...args) => {
      count++;
      return base.saveCursor(...args);
    },
    saveStep: async (...args) => {
      count++;
      return base.saveStep(...args);
    },
  };
  return { store, checkpointCount: () => count };
}

async function computeMode4Plan(): Promise<{ plan: SelectionPlan; checkpointCount: number }> {
  // Lazily loaded via ToolSearch-free dynamic import so this file's static
  // imports don't need a direct `@lostgradient/operative/test` re-export for
  // `createDurableMultiAgentHarness` beyond what's already imported above —
  // kept as a plain top-level import for readability instead; see the
  // module import list.
  const { createDurableMultiAgentHarness } = await import('@lostgradient/operative/test');

  const { store, checkpointCount } = spiedManualCheckpointStore();
  const runWorkflow = createRunWorkflow(store);
  const harness = await createDurableMultiAgentHarness({ runWorkflow });

  try {
    const gate = operative.createSelectionGate({
      request: () => fixtureRequest(),
      options: (): SelectOptions => ({
        catalog: fixtureCatalog([anthropic]),
        now,
        newPlanId: freshNewPlanId(),
      }),
    });
    // Seed the gate's own recorded plan up front, matching how a real
    // Bureau caller's earlier `planSelection()` call would.
    gate.revalidate();

    const toolbox = createToolbox([]);
    const services: DurableRunDeps = {
      toolbox,
      options: {
        generate: createMockGenerate([textResponse('durable done')]),
        toolbox,
        conversation: createConversationHistory(),
        stopWhen: noToolCalls(),
        selection: gate,
      },
    };

    const runId = 'contract-durable-run';
    const handle = await harness.engine.engine.start(
      'agentRun',
      { runId, sessionId: runId, agentName: AGENT_NAME, prompt: 'go' },
      { id: runId, services },
    );
    const result = await handle.result();
    expect(result).toBeDefined();

    const plan = gate.getPlan();
    if (plan === undefined) throw new Error('expected the durable run to leave a recorded plan');
    return { plan, checkpointCount: checkpointCount() };
  } finally {
    harness.dispose();
  }
}

// ── Mode 5: historical replay after the catalog advances ───────────────────

function computeMode5(originalPlan: SelectionPlan): {
  deserializedPlan: SelectionPlan;
  freshPlanAgainstAdvancedCatalog: SelectionPlan;
} {
  // Stand-in for "persisted, then reloaded in a later process": a plain
  // JSON round trip, exercising exactly the serialization boundary a real
  // store would cross — `descriptorSnapshot` is inlined by value (AB-249),
  // so nothing here depends on a live catalog reference surviving the trip.
  const deserializedPlan = JSON.parse(JSON.stringify(originalPlan)) as SelectionPlan;

  // The live catalog advances: the selected descriptor's row is removed
  // ENTIRELY, at a higher revision — the concrete scenario AB-64's replay
  // guarantee must survive.
  const advancedCatalog = fixtureCatalog([], { revision: CATALOG_REVISION + 5 });
  const freshPlanAgainstAdvancedCatalog = select(
    fixtureRequest({ catalogRevision: CATALOG_REVISION + 5 }),
    { catalog: advancedCatalog, now, newPlanId: freshNewPlanId() },
  );

  return { deserializedPlan, freshPlanAgainstAdvancedCatalog };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('cross-mode selection-plan replay contract (AB-251)', () => {
  it('produces the identical normalized decision record across direct Agent, Bureau planSelection, unattenuated child dispatch, durable recovery, and historical replay', async () => {
    const mode1Plan = computeMode1Plan();
    expect(mode1Plan.outcome).toBe('selected');
    expect(mode1Plan.selected).toEqual({
      provider: 'anthropic',
      model: 'claude-fable-5',
      effort: 'low',
    });

    const mode2Plan = await computeMode2Plan();

    const unattenuatedGrant: DelegatedAuthority = {
      grantedProviders: ['anthropic'],
      policyVersion: 'contract-mode3-v1',
    };
    const mode3Plan = await dispatchChildAndCapturePlan(
      fixtureCatalog([anthropic]),
      unattenuatedGrant,
    );

    const { plan: mode4Plan, checkpointCount } = await computeMode4Plan();
    // Rollback-trigger guard (AB-251's operational notes): the suite
    // passing while durable mode silently never reaches a checkpoint. This
    // must observe at least one before the plans are compared.
    expect(checkpointCount).toBeGreaterThan(0);

    const { deserializedPlan, freshPlanAgainstAdvancedCatalog } = computeMode5(mode1Plan);

    const canonical = normalizePlan(mode1Plan);
    expect(normalizePlan(mode2Plan)).toEqual(canonical);
    expect(normalizePlan(mode3Plan)).toEqual(canonical);
    expect(normalizePlan(mode4Plan)).toEqual(canonical);
    expect(normalizePlan(deserializedPlan)).toEqual(canonical);

    // The historical-replay case's concrete proof: the replayed value still
    // reports the ORIGINAL selected value and per-candidate eligibility
    // reasoning even after the live catalog drops the row entirely...
    expect(deserializedPlan.selected).toEqual({
      provider: 'anthropic',
      model: 'claude-fable-5',
      effort: 'low',
    });
    expect(deserializedPlan.candidates).toHaveLength(1);
    expect(deserializedPlan.candidates[0]?.eligible).toBe(true);
    expect(deserializedPlan.candidates[0]?.exclusionCode).toBeUndefined();
    expect(deserializedPlan.candidates[0]?.descriptorSnapshot.model).toBe('claude-fable-5');

    // ...while a FRESH select() call against that same advanced catalog does
    // NOT reproduce 'selected' — proving the replayed value depends on
    // nothing but its own persisted content, never the live catalog.
    expect(freshPlanAgainstAdvancedCatalog.outcome).not.toBe('selected');
    expect(freshPlanAgainstAdvancedCatalog.outcome).toBe('no-candidate');
  });

  it('a child dispatched with an attenuated grant excludes only the child-forbidden candidate, differing from an unattenuated dispatch of the same fixture solely in that regard', async () => {
    const twoCandidateCatalog = fixtureCatalog([anthropic, gemini]);
    const attenuationRequest = fixtureRequest();

    const grandparentGrant: DelegatedAuthority = {
      grantedProviders: ['anthropic', 'gemini'],
      policyVersion: 'contract-grandparent-v1',
    };

    const unattenuatedChildGrant = operative.attenuateDelegatedAuthority(grandparentGrant, {
      grantedProviders: ['anthropic', 'gemini'],
      policyVersion: 'contract-parent-v1',
    });
    const attenuatedChildGrant = operative.attenuateDelegatedAuthority(grandparentGrant, {
      grantedProviders: ['anthropic'],
      policyVersion: 'contract-parent-v2',
    });
    // The attenuation is real, not a no-op supplied by accident.
    expect(attenuatedChildGrant.grantedProviders).toEqual(['anthropic']);
    expect(unattenuatedChildGrant.grantedProviders).toEqual(['anthropic', 'gemini']);

    const unattenuatedPlan = await dispatchChildAndCapturePlan(
      twoCandidateCatalog,
      unattenuatedChildGrant,
      attenuationRequest,
    );
    const attenuatedPlan = await dispatchChildAndCapturePlan(
      twoCandidateCatalog,
      attenuatedChildGrant,
      attenuationRequest,
    );

    // `selected` is unaffected — anthropic already won the (deterministic,
    // no-preference) lexicographic tie-break in both dispatches.
    expect(unattenuatedPlan.selected).toEqual(attenuatedPlan.selected);
    expect(unattenuatedPlan.selected?.provider).toBe('anthropic');

    const unattenuatedAnthropic = unattenuatedPlan.candidates.find(
      (c) => c.provider === 'anthropic',
    );
    const attenuatedAnthropic = attenuatedPlan.candidates.find((c) => c.provider === 'anthropic');
    expect(attenuatedAnthropic).toEqual(unattenuatedAnthropic);

    const unattenuatedGemini = unattenuatedPlan.candidates.find((c) => c.provider === 'gemini');
    const attenuatedGemini = attenuatedPlan.candidates.find((c) => c.provider === 'gemini');
    expect(unattenuatedGemini?.eligible).toBe(true);
    expect(unattenuatedGemini?.exclusionCode).toBeUndefined();
    expect(attenuatedGemini?.eligible).toBe(false);
    expect(attenuatedGemini?.exclusionCode).toBe('exceeds-delegated-authority');
    expect(attenuatedGemini?.exclusionReason).toContain('contract-parent-v2');

    // The two normalized records differ ONLY in the excluded gemini
    // candidate — proven by asserting explicit inequality of the raw plans
    // (never asserting equality) alongside the field-by-field diff above.
    expect(normalizePlan(attenuatedPlan)).not.toEqual(normalizePlan(unattenuatedPlan));
  });
});
