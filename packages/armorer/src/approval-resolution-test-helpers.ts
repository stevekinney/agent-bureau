import { createProcessLocalApprovalStateStore, type ApprovalStateStore } from './approval-binding';
import type { ToolboxExecuteOptions } from './toolbox-contracts';
import type { SignedPendingToolApproval, ToolApprovalAction } from './types';

export const approvalResolutionOwnerId = 'approval-resolution-owner';
export const approvalResolutionSecret = 'approval-resolution-secret';

export type ApprovalResolutionRequestContext = NonNullable<ToolboxExecuteOptions['requestContext']>;

export function createApprovalResolutionRequestContext(
  overrides: Partial<ApprovalResolutionRequestContext> = {},
): ApprovalResolutionRequestContext {
  return {
    authority: {
      principalId: approvalResolutionOwnerId,
      tenantId: 'approval-resolution-tenant',
      ownerId: approvalResolutionOwnerId,
      capabilities: [],
      authorizationRevision: '1',
    },
    audience: 'tenant',
    agentId: 'approval-resolution-agent',
    runId: 'approval-resolution-run',
    ...overrides,
  };
}

export function requireSignedApproval(result: {
  pendingApproval?: unknown;
}): SignedPendingToolApproval {
  const approval = result.pendingApproval as SignedPendingToolApproval | undefined;
  if (!approval?.approvalToken) throw new Error('missing signed pending approval');
  return approval;
}

export function requireApprovalAction(action: unknown): ToolApprovalAction {
  if (typeof action !== 'object' || action === null || !('type' in action)) {
    throw new Error('missing approval action');
  }
  const candidate = action as ToolApprovalAction;
  if (candidate.type !== 'approval') throw new Error('expected approval action');
  return candidate;
}

export function createApprovalResolutionMapStore() {
  const map = new Map<string, string>();
  return {
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async set(key: string, value: string) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
    async list(prefix: string) {
      return [...map.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

export function createCountingApprovalStateStore(now?: () => number) {
  const inner = createProcessLocalApprovalStateStore(now);
  const counts = { reserve: 0, revoke: 0, release: 0, commit: 0 };
  const store: ApprovalStateStore = {
    ...inner,
    async reserve(binding, context, validationTime) {
      counts.reserve += 1;
      await inner.reserve(binding, context, validationTime);
    },
    async revoke(binding) {
      counts.revoke += 1;
      await inner.revoke(binding);
    },
    async release(binding) {
      counts.release += 1;
      await inner.release(binding);
    },
    async commit(binding) {
      counts.commit += 1;
      await inner.commit(binding);
    },
  };
  return { store, counts };
}

function createDeferred() {
  let resolveDeferred!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function createAwaitGate() {
  return {
    started: createDeferred(),
    release: createDeferred(),
  };
}

export function createDeferredReserveRevokeApprovalStateStore() {
  const inner = createProcessLocalApprovalStateStore();
  const reserve = createAwaitGate();
  const revoke = createAwaitGate();
  const store: ApprovalStateStore = {
    ...inner,
    async reserve(binding, context, validationTime) {
      await inner.reserve(binding, context, validationTime);
      reserve.started.resolve();
      await reserve.release.promise;
    },
    async revoke(binding) {
      revoke.started.resolve();
      await revoke.release.promise;
      await inner.revoke(binding);
    },
  };
  return { store, reserve, revoke };
}

export function createDeferredStateApprovalStateStore() {
  const inner = createProcessLocalApprovalStateStore();
  const state = createAwaitGate();
  const store: ApprovalStateStore = {
    ...inner,
    async state(binding) {
      state.started.resolve();
      await state.release.promise;
      return inner.state(binding);
    },
  };
  return { store, state };
}
