import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { type ApprovalStateStore, createProcessLocalApprovalStateStore } from './approval-binding';
import { createTool, createToolCall } from './create-tool';
import { createToolbox } from './create-toolbox';
import type { Tool } from './is-tool';
import type { ToolboxExecuteOptions } from './toolbox-contracts';
import type { ToolboxSettledEvent } from './toolbox-lifecycle-events';
import type { SignedPendingToolApproval } from './types';

const ownerId = 'issuance-owner';
const approvalSecret = 'issuance-test-secret';

type RequestContext = NonNullable<ToolboxExecuteOptions['requestContext']>;

function createRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    authority: {
      principalId: ownerId,
      tenantId: 'issuance-tenant',
      ownerId,
      capabilities: [],
      authorizationRevision: '1',
    },
    audience: 'tenant',
    agentId: 'issuance-agent',
    runId: 'issuance-run',
    ...overrides,
  };
}

type GatedToolOptions = { readonly version?: string | undefined };

function createGatedTool(name: string, options: GatedToolOptions = { version: '1.0.0' }) {
  const callbacks = { count: 0 };
  const tool = createTool({
    name,
    description: 'Approval issuance settlement test tool',
    input: z.object({}),
    ...(options.version === undefined ? {} : { version: options.version }),
    policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve this call' }) },
    execute: async () => {
      callbacks.count += 1;
      return 'must not execute';
    },
  });
  return { tool, callbacks };
}

type StoreHooks = {
  readonly beforeIssue?: () => Promise<void> | void;
  readonly afterRevoke?: () => void;
};

function createProbeStore(hooks: StoreHooks = {}) {
  const inner = createProcessLocalApprovalStateStore();
  const probe = { issueCalls: 0, revokeCalls: 0 };
  const store: ApprovalStateStore = {
    ...inner,
    async issue(binding) {
      probe.issueCalls += 1;
      await hooks.beforeIssue?.();
      await inner.issue(binding);
    },
    async revoke(binding) {
      probe.revokeCalls += 1;
      await inner.revoke(binding);
      hooks.afterRevoke?.();
    },
  };
  return { store, probe };
}

type SettlementRecord = {
  readonly callId: string;
  readonly status: string;
  readonly executionId: string | undefined;
  readonly ownerId: string | undefined;
  readonly result: unknown;
  readonly error: unknown;
  readonly callbackCompletion: unknown;
};

function toSettlementRecord(event: ToolboxSettledEvent): SettlementRecord {
  return {
    callId: event.call.id,
    status: event.status,
    executionId: event.executionId,
    ownerId: event.ownerId,
    result: event.result,
    error: event.error,
    callbackCompletion: event.callbackCompletion,
  };
}

function createSettlementLog(expected: number) {
  const records: SettlementRecord[] = [];
  const reached = Promise.withResolvers<void>();
  return {
    records,
    reached: reached.promise,
    record(event: ToolboxSettledEvent) {
      records.push(toSettlementRecord(event));
      if (records.length >= expected) reached.resolve();
    },
  };
}

const bubbledEventTypes = ['execute-start', 'settled', 'progress', 'policy-denied'] as const;

/**
 * `subscribeToolEvents` attaches one bubble listener per tool event type to the
 * tool's own emitter and releases them through the invocation's `cleanup`
 * array, so the tool emitter is where a skipped cleanup shows up.
 */
function captureToolEventTarget(tool: { addEventListener: Tool['addEventListener'] }): EventTarget {
  let target: EventTarget | undefined;
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    // The temporary wrapper is the narrow capture needed to inspect the actual emitter.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    target ??= this;
    if (listener === null) return;
    return originalAddEventListener.call(this, type, listener, options);
  };
  try {
    const unsubscribe = tool.addEventListener('settled', () => {});
    unsubscribe();
  } finally {
    EventTarget.prototype.addEventListener = originalAddEventListener;
  }
  if (!target) throw new Error('failed to capture tool EventTarget');
  return target;
}

function bubbledListenerCounts(target: EventTarget): Record<string, number> {
  return Object.fromEntries(
    bubbledEventTypes.map((type) => [type, getEventListeners(target, type).length]),
  );
}

function errorCode(settlement: SettlementRecord | undefined): string | undefined {
  const error = settlement?.error;
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

describe('approval issuance settlement ordering', () => {
  it('withholds the paused toolbox settlement until issuance is authoritative', async () => {
    const issueEntered = Promise.withResolvers<void>();
    const releaseIssue = Promise.withResolvers<void>();
    const { store, probe } = createProbeStore({
      beforeIssue: async () => {
        issueEntered.resolve();
        await releaseIssue.promise;
      },
    });
    const { tool, callbacks } = createGatedTool('issuance-paused');
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const log = createSettlementLog(1);
    const starts: (string | undefined)[] = [];
    toolbox.addEventListener('execute-start', (event) => {
      starts.push(event.executionId);
    });
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-paused-call');

    const execution = toolbox.execute(call, { ownerId, requestContext: createRequestContext() });
    await issueEntered.promise;

    expect(probe.issueCalls).toBe(1);
    expect(log.records).toHaveLength(0);

    releaseIssue.resolve();
    const result = await execution;

    expect(result.outcome).toBe('action_required');
    expect(callbacks.count).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('paused');
    expect(log.records[0]?.callId).toBe(call.id);
    expect(log.records[0]?.executionId).toBe(starts[0]);
    expect(log.records[0]?.executionId).toBeTruthy();
    expect(log.records[0]?.ownerId).toBe(ownerId);
    expect(log.records[0]?.result).toBeUndefined();
    expect(log.records[0]?.error).toBeUndefined();
    expect(log.records[0]?.callbackCompletion).toBeInstanceOf(Promise);
    expect(probe.revokeCalls).toBe(0);
  });

  it('settles error when the approval state store rejects issuance', async () => {
    const { store } = createProbeStore({
      beforeIssue: () => {
        throw new Error('store rejected issuance');
      },
    });
    const { tool, callbacks } = createGatedTool('issuance-store-rejection');
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-store-rejection-call');

    const result = await toolbox.execute(call, {
      ownerId,
      requestContext: createRequestContext(),
    });

    expect(result.outcome).toBe('error');
    expect(callbacks.count).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(log.records[0]?.callId).toBe(call.id);
    expect(log.records[0]?.ownerId).toBe(ownerId);
    expect(log.records[0]?.result).toBeUndefined();
    expect(log.records[0]?.error).toEqual(result.error);
    expect(log.records[0]?.callbackCompletion).toBeInstanceOf(Promise);
  });

  it('settles error when the approval request context is missing', async () => {
    const { tool, callbacks } = createGatedTool('issuance-missing-context');
    const toolbox = createToolbox([tool], { approvalSecret });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-missing-context-call');

    const result = await toolbox.execute(call, { ownerId });

    expect(result.outcome).toBe('error');
    expect(callbacks.count).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(log.records[0]?.callId).toBe(call.id);
    expect(log.records[0]?.result).toBeUndefined();
    expect(log.records[0]?.error).toEqual(result.error);
  });

  it('settles error when the tool definition carries no version', async () => {
    const { tool, callbacks } = createGatedTool('issuance-missing-version', { version: undefined });
    const toolbox = createToolbox([tool], { approvalSecret });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-missing-version-call');

    const result = await toolbox.execute(call, {
      ownerId,
      requestContext: createRequestContext(),
    });

    expect(result.outcome).toBe('error');
    expect(callbacks.count).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(log.records[0]?.error).toEqual(result.error);
  });

  /**
   * This test used to induce the failure with `action: { message: 1n }`, which
   * reached `signPendingApproval` intact and made its `JSON.stringify` throw,
   * because `ToolAction.message` was the one action field that never passed
   * through normalization. COR-1220 coerces it, so that input can no longer
   * reach signing and the original premise is gone.
   *
   * The signing-error branch appears unreachable now. `signPendingApproval` has
   * two throw sources: a missing `approvalSecret`, which
   * `signPendingApprovalIfConfigured` already makes unreachable by returning
   * early, and the `JSON.stringify` in its payload normalization. Six candidate
   * carriers for a non-serializable value were probed against the coerced build
   * — `message`, `operation.argsPreview`, `metadata`, `editableArgs`,
   * `expiresAt`, and the call arguments — and none reaches it: the first three
   * normalize, and the last three are rejected by earlier validation. That is a
   * failure to find a trigger rather than a proof none exists, so the branch
   * stays.
   *
   * What this test owes COR-45 is the settlement behavior, not the trigger: one
   * settlement per call, an error path that settles `error` rather than
   * `paused`, and an approval store never touched when issuance fails. It now
   * induces the failure through approval binding, which is the same region of
   * issuance the signing failure came from.
   *
   * Action validation was tried first and rejected as the trigger. It fails
   * earlier, and on that path the settled event carries a raw `Error` while
   * `result.error` carries the structured shape, so `log.records[0]?.error`
   * and `result.error` are not equal. That asymmetry between two failure paths
   * looks like a real inconsistency, but it is out of this issue's scope and
   * is not something to paper over by relaxing the assertion here.
   */
  it('settles error once and never reaches the approval store when binding fails', async () => {
    const { store, probe } = createProbeStore();
    const { tool, callbacks } = createGatedTool('issuance-unsignable');
    const toolbox = createToolbox([tool], {
      approvalSecret,
      approvalStateStore: store,
      approvalNow: () => Number.MAX_VALUE,
    });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-unsignable-call');

    const result = await toolbox.execute(call, {
      ownerId,
      requestContext: createRequestContext(),
    });

    expect(result.outcome).toBe('error');
    expect(callbacks.count).toBe(0);
    expect(probe.issueCalls).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(log.records[0]?.callId).toBe(call.id);
    expect(log.records[0]?.result).toBeUndefined();
    expect(log.records[0]?.error).toEqual(result.error);
  });

  it('settles error when the approval binding expiry is invalid', async () => {
    const { tool, callbacks } = createGatedTool('issuance-invalid-expiry');
    const toolbox = createToolbox([tool], {
      approvalSecret,
      approvalNow: () => Number.MAX_VALUE,
    });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-invalid-expiry-call');

    const result = await toolbox.execute(call, {
      ownerId,
      requestContext: createRequestContext(),
    });

    expect(result.outcome).toBe('error');
    expect(callbacks.count).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(log.records[0]?.error).toEqual(result.error);
  });

  it('settles error once and revokes late issuance when cancelled mid-issuance', async () => {
    const issueEntered = Promise.withResolvers<void>();
    const releaseIssue = Promise.withResolvers<void>();
    const revoked = Promise.withResolvers<void>();
    const { store, probe } = createProbeStore({
      beforeIssue: async () => {
        issueEntered.resolve();
        await releaseIssue.promise;
      },
      afterRevoke: () => revoked.resolve(),
    });
    const { tool, callbacks } = createGatedTool('issuance-cancelled');
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const controller = new AbortController();
    const call = createToolCall(tool.name, {}, 'issuance-cancelled-call');

    const execution = toolbox.execute(call, {
      ownerId,
      requestContext: createRequestContext(),
      signal: controller.signal,
    });
    await issueEntered.promise;
    expect(log.records).toHaveLength(0);

    controller.abort('cancelled by test');
    releaseIssue.resolve();
    const result = await execution;
    await revoked.promise;

    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('CANCELLED');
    expect(callbacks.count).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(log.records[0]?.callId).toBe(call.id);
    expect(errorCode(log.records[0])).toBe('CANCELLED');
    expect(probe.revokeCalls).toBe(1);
  });

  it('settles error when the request deadline expires before issuance', async () => {
    const clock = { value: 0 };
    const { store, probe } = createProbeStore();
    const callbacks = { count: 0 };
    const tool = createTool({
      name: 'issuance-deadline',
      version: '1.0.0',
      description: 'Approval issuance settlement test tool',
      input: z.object({}),
      policy: {
        beforeExecute: () => {
          clock.value = 2000;
          return { status: 'needs_approval', reason: 'Approve this call' };
        },
      },
      execute: async () => {
        callbacks.count += 1;
        return 'must not execute';
      },
    });
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const log = createSettlementLog(1);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const call = createToolCall(tool.name, {}, 'issuance-deadline-call');

    const result = await toolbox.execute(call, {
      ownerId,
      requestContext: createRequestContext({ deadline: 1000 }),
      now: () => clock.value,
      setTimeoutFunction: () => 0,
      clearTimeoutFunction: () => undefined,
    });

    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('TIMEOUT');
    expect(callbacks.count).toBe(0);
    expect(probe.issueCalls).toBe(0);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.status).toBe('error');
    expect(errorCode(log.records[0])).toBe('TIMEOUT');
  });

  it('returns bubbled tool listeners to baseline after repeated cancelled issuance', async () => {
    const pendingIssuance: Array<() => void> = [];
    const { store } = createProbeStore({
      beforeIssue: () =>
        new Promise<void>((resolve) => {
          pendingIssuance.push(resolve);
        }),
    });
    const { tool, callbacks } = createGatedTool('issuance-listener-drain');
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const registeredTool = toolbox.tools()[0]!;
    const target = captureToolEventTarget(registeredTool);
    const baseline = bubbledListenerCounts(target);
    expect(baseline).toEqual({
      'execute-start': 0,
      settled: 0,
      progress: 0,
      'policy-denied': 0,
    });

    for (const round of [1, 2, 3]) {
      const controller = new AbortController();
      const execution = toolbox.execute(createToolCall(tool.name, {}, `drain-call-${round}`), {
        ownerId,
        requestContext: createRequestContext(),
        signal: controller.signal,
      });
      while (pendingIssuance.length === 0) await Promise.resolve();
      controller.abort('cancelled by test');
      pendingIssuance.pop()?.();
      const result = await execution;

      expect(result.outcome).toBe('error');
      expect(result.error?.code).toBe('CANCELLED');
      expect(bubbledListenerCounts(target)).toEqual(baseline);
    }

    expect(callbacks.count).toBe(0);
  });

  it('terminates the child execution of a batch call interrupted during issuance', async () => {
    const pendingIssuance: Array<() => void> = [];
    const { store } = createProbeStore({
      beforeIssue: () =>
        new Promise<void>((resolve) => {
          pendingIssuance.push(resolve);
        }),
    });
    const first = createGatedTool('issuance-batch-interrupt-a');
    const second = createGatedTool('issuance-batch-interrupt-b');
    const toolbox = createToolbox([first.tool, second.tool], {
      approvalSecret,
      approvalStateStore: store,
    });
    const target = captureToolEventTarget(toolbox.tools()[0]!);
    const baseline = bubbledListenerCounts(target);
    const log = createSettlementLog(2);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const controller = new AbortController();

    const execution = toolbox.execute(
      [
        createToolCall(first.tool.name, {}, 'batch-interrupt-a'),
        createToolCall(second.tool.name, {}, 'batch-interrupt-b'),
      ],
      { ownerId, requestContext: createRequestContext(), signal: controller.signal },
    );
    while (pendingIssuance.length < 2) await Promise.resolve();
    controller.abort('cancelled by test');
    while (pendingIssuance.length > 0) pendingIssuance.pop()?.();
    const results = await execution;
    await log.reached;

    expect(results.map((result) => result.outcome)).toEqual(['error', 'error']);
    expect(first.callbacks.count).toBe(0);
    expect(second.callbacks.count).toBe(0);
    expect(log.records).toHaveLength(2);
    expect(log.records.every((record) => record.status === 'error')).toBe(true);
    expect(bubbledListenerCounts(target)).toEqual(baseline);
    const childStates = toolbox.executions
      .inspect()
      .filter((snapshot) => snapshot.parentExecutionId !== undefined)
      .map((snapshot) => snapshot.state);
    expect(childStates.every((state) => state === 'terminal')).toBe(true);
  });

  it('settles paused after issuance and success after an approved resume', async () => {
    const callbacks = { count: 0 };
    const tool = createTool({
      name: 'issuance-resume',
      version: '1.0.0',
      description: 'Approval issuance settlement test tool',
      input: z.object({ value: z.string() }),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve this call' }) },
      execute: async ({ value }) => {
        callbacks.count += 1;
        return value;
      },
    });
    const { store } = createProbeStore();
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const log = createSettlementLog(2);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const requestContext = createRequestContext();
    const call = createToolCall(tool.name, { value: 'approved' }, 'issuance-resume-call');

    const parked = await toolbox.execute(call, { ownerId, requestContext });
    expect(parked.outcome).toBe('action_required');
    const pendingApproval = parked.pendingApproval;
    if (!pendingApproval?.approvalToken) throw new Error('missing signed pending approval');
    const resumed = await toolbox.resumeApproval(pendingApproval as SignedPendingToolApproval, {
      requestContext,
    });

    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toBe('approved');
    expect(callbacks.count).toBe(1);
    expect(log.records).toHaveLength(2);
    expect(log.records.map((record) => record.status)).toEqual(['paused', 'success']);
    expect(log.records.every((record) => record.callId === call.id)).toBe(true);
  });

  it('settles every call exactly once in a collect-mode batch', async () => {
    const issueEntered = Promise.withResolvers<void>();
    const releaseIssue = Promise.withResolvers<void>();
    const { store } = createProbeStore({
      beforeIssue: async () => {
        issueEntered.resolve();
        await releaseIssue.promise;
      },
    });
    const issued = createGatedTool('issuance-batch-ok');
    const unversioned = createGatedTool('issuance-batch-broken', { version: undefined });
    const toolbox = createToolbox([issued.tool, unversioned.tool], {
      approvalSecret,
      approvalStateStore: store,
    });
    const log = createSettlementLog(2);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const okCall = createToolCall(issued.tool.name, {}, 'issuance-batch-ok-call');
    const brokenCall = createToolCall(unversioned.tool.name, {}, 'issuance-batch-broken-call');

    const execution = toolbox.execute([okCall, brokenCall], {
      ownerId,
      requestContext: createRequestContext(),
      errorMode: 'collect',
    });
    await issueEntered.promise;
    expect(log.records.some((record) => record.callId === okCall.id)).toBe(false);
    releaseIssue.resolve();
    const results = await execution;
    await log.reached;

    expect(results).toHaveLength(2);
    expect(results[0]?.outcome).toBe('action_required');
    expect(results[1]?.outcome).toBe('error');
    expect(issued.callbacks.count).toBe(0);
    expect(unversioned.callbacks.count).toBe(0);
    expect(log.records).toHaveLength(2);
    const okSettlement = log.records.find((record) => record.callId === okCall.id);
    const brokenSettlement = log.records.find((record) => record.callId === brokenCall.id);
    expect(okSettlement?.status).toBe('paused');
    expect(brokenSettlement?.status).toBe('error');
    expect(brokenSettlement?.result).toBeUndefined();
    expect(brokenSettlement?.error).toEqual(results[1]?.error);
  });

  it('settles every call exactly once in a failFast batch and rejects with the original error', async () => {
    const issueEntered = Promise.withResolvers<void>();
    const releaseIssue = Promise.withResolvers<void>();
    const { store } = createProbeStore({
      beforeIssue: async () => {
        issueEntered.resolve();
        await releaseIssue.promise;
      },
    });
    const issued = createGatedTool('fail-fast-batch-ok');
    const unversioned = createGatedTool('fail-fast-batch-broken', { version: undefined });
    const toolbox = createToolbox([issued.tool, unversioned.tool], {
      approvalSecret,
      approvalStateStore: store,
    });
    const log = createSettlementLog(2);
    toolbox.addEventListener('settled', (event) => log.record(event));
    const okCall = createToolCall(issued.tool.name, {}, 'fail-fast-batch-ok-call');
    const brokenCall = createToolCall(unversioned.tool.name, {}, 'fail-fast-batch-broken-call');

    const execution = toolbox.execute([okCall, brokenCall], {
      ownerId,
      requestContext: createRequestContext(),
      errorMode: 'failFast',
    });
    const rejection = execution.then(
      () => undefined,
      (error: unknown) => error,
    );
    await issueEntered.promise;
    releaseIssue.resolve();
    const thrown = await rejection;
    await log.reached;

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('versioned tool definition');
    expect(issued.callbacks.count).toBe(0);
    expect(unversioned.callbacks.count).toBe(0);
    expect(log.records).toHaveLength(2);
    const okSettlement = log.records.find((record) => record.callId === okCall.id);
    const brokenSettlement = log.records.find((record) => record.callId === brokenCall.id);
    expect(okSettlement?.status).toBe('paused');
    expect(brokenSettlement?.status).toBe('error');
    expect(brokenSettlement?.result).toBeUndefined();
    expect(errorCode(brokenSettlement)).toBe('EXECUTION_ERROR');
  });
});
