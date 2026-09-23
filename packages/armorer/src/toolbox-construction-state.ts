import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';

import {
  createProcessLocalApprovalStateStore,
  createProcessLocalGrantStateStore,
} from './approval-binding';
import { LoopDetector } from './core/loop-detection';
import type { ToolboxOptions } from './toolbox-contracts';
import { createCachedEmbedder } from './toolbox-runtime-helpers';

export function resolveToolboxConstructionState(options: ToolboxOptions) {
  const runtime: RuntimeServices = options.runtime ?? createDefaultRuntimeServices();
  const policyState = resolvePolicyState(options);
  const budgetStart = runtime.clock.now();
  const budgetCalls = { value: 0 };
  const autoLoopDetector = createAutoLoopDetector(options.loopDetection);
  const loopDetectors = new Map<string, LoopDetector>();
  const approvalState = resolveApprovalState(options, runtime);
  const revisions = resolveRevisions(options);
  return {
    runtime,
    ...policyState,
    budgetStart,
    budgetCalls,
    embedder: options.embed ? createCachedEmbedder(options.embed) : undefined,
    onDeprecatedToolCalled: options.onDeprecatedToolCalled,
    resolutionEnabled: options.resolution === true || typeof options.resolution === 'object',
    autoLoopDetector,
    loopDetectors,
    ...approvalState,
    ...revisions,
  };
}

function resolvePolicyState(options: ToolboxOptions) {
  const readOnly = options.readOnly ?? false;
  return {
    baseContext: options.context ? { ...options.context } : {},
    readOnly,
    allowMutation: options.allowMutation ?? !readOnly,
    allowDangerous: options.allowDangerous ?? true,
    approvalPolicy: options.approvalPolicy,
    telemetryEnabled: options.telemetry === true,
    registryPolicy: options.policy,
    registryPolicyContext: options.policyContext,
    registryDigests: options.digests,
    registryConcurrency: options.concurrency,
    budget: options.budget,
  };
}

function resolveApprovalState(options: ToolboxOptions, runtime: RuntimeServices) {
  const approvalNow = options.approvalNow ?? runtime.clock.now;
  const approvalSecret = options.approvalSecret;
  const approvalStateStore =
    options.approvalStateStore ??
    (approvalSecret ? createProcessLocalApprovalStateStore(approvalNow) : undefined);
  const approvalBindingTtlMs = options.approvalBindingTtlMs ?? 5 * 60_000;
  if (!Number.isFinite(approvalBindingTtlMs) || approvalBindingTtlMs <= 0) {
    throw new Error('approvalBindingTtlMs must be finite and positive.');
  }
  return {
    approvalNow,
    approvalSecret,
    approvalStateStore,
    approvalBindingTtlMs,
    approvalNonce: options.approvalNonce ?? (() => runtime.identifiers.next('approval')),
    grantStateStore:
      options.grantStateStore ?? (approvalSecret ? createProcessLocalGrantStateStore() : undefined),
  };
}

function resolveRevisions(options: ToolboxOptions) {
  return {
    catalogRevision: options.catalogRevision ?? 'catalog:1',
    toolboxRevision: options.toolboxRevision ?? 'toolbox:1',
    policyRevision: options.policyRevision ?? 'policy:1',
    approvalRevision: options.approvalRevision ?? 'approval:1',
    redactionRevision: options.redactionRevision ?? 'redaction:1',
  };
}

function createAutoLoopDetector(value: ToolboxOptions['loopDetection']): LoopDetector | undefined {
  if (!value) return undefined;
  if (typeof value === 'object') return new LoopDetector(value);
  return new LoopDetector({ warningThreshold: 10, blockThreshold: 20 });
}
