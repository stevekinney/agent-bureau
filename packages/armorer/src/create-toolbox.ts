import { CompletableEventTarget } from '@lostgradient/lifecycle';
import type { ToolboxEventMap } from './event-types';

import { registerRegistryEmbedder } from './core/registry/embeddings';
import {
  type EffectiveToolExecutionContext,
  freezeEffectiveToolExecutionContext,
} from './execution-context';
import { createExecutionLifecycle } from './execution-lifecycle';
import type { Tool, ToolConfiguration } from './is-tool';
import { createToolboxApprovalApi } from './toolbox-approval-api';
import { createInterruptedResumeApprovalValidationResult } from './toolbox-approval-validation';
import { isToolAvailable as checkToolAvailability } from './toolbox-availability';
import { createToolBuilder } from './toolbox-builder';
import { normalizeConfiguration as normalizeRegisteredConfiguration } from './toolbox-configuration';
import { resolveToolboxConstructionState } from './toolbox-construction-state';
import { completeToolboxOnAbort, createToolboxEventEmitter } from './toolbox-event-lifecycle';
import { createExecutor } from './toolbox-execution';
import { createToolboxExtension } from './toolbox-extension';
import { createToolboxProviderSurface } from './toolbox-provider-factories';
import { createToolboxPublicSurface } from './toolbox-public-surface';
import { createToolboxRegistrationState } from './toolbox-registration-state';
import {
  createToolboxBudgetExceededToolError,
  createToolError,
  extractErrorCode,
} from './toolbox-runtime-helpers';
import { createToolAccessor } from './toolbox-tool-access';
import { createToolboxViewState } from './toolbox-view-state';
import type { ToolCallInput } from './types';

import type { ToolboxEntries, ToolboxExecuteOptions, ToolboxOptions } from './toolbox-contracts';
import type { Toolbox } from './toolbox-interface';
import { registerInternalToolboxOptions } from './toolbox-internal-registry';
import type { ToolsFromEntries } from './toolbox-type-inference';

function createToolboxBase(): Toolbox;
function createToolboxBase<const TEntries extends ToolboxEntries>(
  entries: TEntries,
  options?: ToolboxOptions,
): Toolbox<ToolsFromEntries<TEntries>>;
function createToolboxBase(entries: ToolboxEntries = [], options: ToolboxOptions = {}): Toolbox {
  const toolsById = new Map<string, Tool>();
  const toolsByName = new Map<string, Tool[]>();
  const getTool = createToolAccessor(toolsById, toolsByName);
  const storedConfigurations = new Map<string, ToolConfiguration>();
  const emitter = new CompletableEventTarget<ToolboxEventMap>();
  const state = resolveToolboxConstructionState(options);
  const {
    runtime,
    baseContext,
    readOnly,
    allowMutation,
    allowDangerous,
    approvalPolicy,
    telemetryEnabled,
    registryPolicy,
    registryPolicyContext,
    registryDigests,
    registryConcurrency,
    budget,
    budgetStart,
    budgetCalls,
    embedder,
    onDeprecatedToolCalled,
    resolutionEnabled,
    autoLoopDetector,
    loopDetectors,
    approvalNow,
    approvalSecret,
    approvalStateStore,
    approvalBindingTtlMs,
    approvalNonce,
    grantStateStore,
    catalogRevision,
    toolboxRevision,
    policyRevision,
    approvalRevision,
    redactionRevision,
  } = state;
  const executionLifecycle = createExecutionLifecycle(undefined, runtime);
  let loopDetectorIdCounter = 0;
  const eventLifecycle = createToolboxEventEmitter(emitter, loopDetectors, executionLifecycle);
  const { addEventListener, dispatchEvent, emit, complete } = eventLifecycle;
  const registrationContext = {
    options,
    runtime,
    baseContext,
    dispatchEvent,
    emit,
    registryPolicy,
    registryPolicyContext,
    registryDigests,
    registryConcurrency,
    readOnly,
    allowMutation,
    allowDangerous,
    approvalPolicy,
    grantStateStore,
    approvalSecret,
    approvalNow,
    policyRevision,
    telemetryEnabled,
  } as const;
  function createEffectiveExecutionContext(
    requestContext: NonNullable<ToolboxExecuteOptions['requestContext']>,
    toolDefinitionRevision: string,
  ): EffectiveToolExecutionContext {
    return freezeEffectiveToolExecutionContext({
      ...requestContext,
      revisions: Object.freeze({
        catalog: catalogRevision,
        toolbox: toolboxRevision,
        toolDefinition: toolDefinitionRevision,
        policy: policyRevision,
        approval: approvalRevision,
        redaction: redactionRevision,
      }),
    });
  }
  function toolDefinitionRevisionForCall(call: ToolCallInput | undefined): string {
    if (!call?.name) {
      return 'unknown';
    }
    return getTool(call.name)?.id ?? call.name;
  }
  const buildTool = createToolBuilder(
    options,
    registrationContext,
    dispatchEvent,
    emit,
    baseContext,
  );

  if (options.signal) completeToolboxOnAbort(options.signal, complete);

  const execute = createExecutor<ToolboxEntries>({
    runtime,
    executionLifecycle,
    toolsByName,
    getTool,
    resolutionEnabled,
    emit,
    storedConfigurations,
    onDeprecatedToolCalled,
    loopDetectors,
    autoLoopDetector,
    budget,
    budgetStart,
    budgetCalls,
    baseContext,
    createEffectiveExecutionContext,
    toolDefinitionRevisionForCall,
    createToolError,
    createToolboxBudgetExceededToolError,
    extractErrorCode,
    isToolAvailable: (tool, signal) => checkToolAvailability(tool, baseContext, signal),
    approvalSecret,
    approvalStateStore,
    approvalNow,
    approvalBindingTtlMs,
    approvalNonce,
    toolboxRevision,
    policyRevision,
    approvalRevision,
    createInterruptedResumeApprovalValidationResult,
  });

  const extend = createToolboxExtension({
    baseContext,
    storedConfigurations,
    options,
    approvalStateStore,
    grantStateStore,
    createToolbox: (extensionEntries, extensionOptions) =>
      createToolboxBase(extensionEntries, extensionOptions),
  });

  const approvalApi = createToolboxApprovalApi({
    approvalSecret,
    approvalStateStore,
    grantStateStore,
    approvalNow,
    approvalNonce,
    toolboxRevision,
    policyRevision,
    approvalRevision,
    runtime,
    getTool,
    execute: (call, executeOptions) => execute(call, executeOptions),
    createToolError,
  });

  const views = createToolboxViewState({
    toolsById,
    getTool,
    storedConfigurations,
    baseContext,
  });

  const api = createToolboxPublicSurface<ToolboxEntries>({
    views,
    execute,
    ...approvalApi,
    extend,
    getTool,
    addEventListener,
    dispatchEvent,
    emit,
    emitter,
    complete,
    executionLifecycle,
    baseContext,
    loopDetectors,
    nextLoopDetectorId: () => loopDetectorIdCounter++,
  });

  const registration = createToolboxRegistrationState({
    options,
    storedConfigurations,
    toolsById,
    toolsByName,
    buildTool,
    normalize: normalizeRegisteredConfiguration,
    api,
    embedder,
  });
  if (entries.length > 0) {
    registration.registerSerialized(
      entries,
      options.getTool !== undefined ? 'deserializing' : 'registration',
    );
  }
  if (embedder) registerRegistryEmbedder(api, embedder);

  // AB-362: retain the resolved private options used by this toolbox.
  registerInternalToolboxOptions(views.toJSON, {
    registryPolicy,
    registryPolicyContext,
    approvalPolicy,
    approvalSecret,
    approvalStateStore,
    grantStateStore,
    approvalBindingTtlMs,
    approvalNow,
    approvalNonce,
    policyRevision,
    approvalRevision,
    toolboxRevision,
    readOnly,
    allowMutation,
    allowDangerous,
  });

  return api;
}

export const createToolbox = Object.assign(
  createToolboxBase,
  createToolboxProviderSurface(createToolboxBase),
);
export type CreateToolbox = typeof createToolbox;
