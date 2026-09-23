import type { RuntimeServices } from '@lostgradient/lifecycle';

import { type GrantStateStore } from './approval-binding';
import { createTool as createToolFactory, type CreateToolOptions } from './create-tool';
import type {
  Tool,
  ToolConfiguration,
  ToolConfigurationInput,
  ToolEventsMap,
  ToolMetadata,
} from './is-tool';
import { mergeRuntimeToolContext } from './runtime-tool-context';
import { normalizeRegistration, resolveMissingExecute } from './toolbox-configuration';
import type {
  GrantUsedDetail,
  ToolboxEntries,
  ToolboxEventDispatcher,
  ToolboxEventType,
  ToolboxEvents,
  ToolboxOptions,
} from './toolbox-contracts';
import { resolveToolConcurrency, resolveToolDigests } from './toolbox-imports';
import { mergePolicies, mergePolicyContexts } from './toolbox-policy';
import { isPromise } from './type-guards';

export type ToolboxEmitter = <K extends ToolboxEventType>(
  type: K,
  detail: ToolboxEvents[K],
) => boolean;

export type ToolboxRegistrationContext = {
  readonly options: ToolboxOptions;
  readonly runtime: RuntimeServices;
  readonly baseContext: Record<string, unknown>;
  readonly dispatchEvent: ToolboxEventDispatcher;
  readonly emit: ToolboxEmitter;
  readonly registryPolicy: ToolboxOptions['policy'];
  readonly registryPolicyContext: ToolboxOptions['policyContext'];
  readonly registryDigests: ToolboxOptions['digests'];
  readonly registryConcurrency: ToolboxOptions['concurrency'];
  readonly readOnly: boolean;
  readonly allowMutation: boolean;
  readonly allowDangerous: boolean;
  readonly approvalPolicy: ToolboxOptions['approvalPolicy'];
  readonly grantStateStore: GrantStateStore | undefined;
  readonly approvalSecret: string | undefined;
  readonly approvalNow: () => number;
  readonly policyRevision: string | undefined;
  readonly telemetryEnabled: boolean;
};

export function buildDefaultTool(
  configuration: ToolConfiguration,
  context: ToolboxRegistrationContext,
): Tool {
  const executeSource = readExecuteSource(configuration);
  const resolveExecute = createLazyExecuteResolver(executeSource, configuration.name);
  const resolvedPolicy = mergePolicies(context.registryPolicy, configuration.policy, {
    readOnly: context.readOnly,
    allowMutation: context.allowMutation,
    allowDangerous: context.allowDangerous,
    ...(context.approvalPolicy !== undefined ? { approvalPolicy: context.approvalPolicy } : {}),
    ...(context.grantStateStore && context.approvalSecret
      ? {
          grantStateStore: context.grantStateStore,
          grantSecret: context.approvalSecret,
          grantNow: context.approvalNow,
          ...(context.policyRevision !== undefined
            ? { grantPolicyRevision: context.policyRevision }
            : {}),
          onGrantUsed: (detail: GrantUsedDetail) => context.emit('grant.used', detail),
        }
      : {}),
  });
  const resolvedPolicyContext = mergePolicyContexts(
    context.registryPolicyContext,
    configuration.policyContext,
  );
  const options = createToolOptions(
    configuration,
    context,
    resolveExecute,
    resolvedPolicy,
    resolvedPolicyContext,
  );
  return createToolFactory({ ...options, input: configuration.input });
}

function createToolOptions(
  configuration: ToolConfiguration,
  context: ToolboxRegistrationContext,
  resolveExecute: () => Promise<(params: unknown, context?: unknown) => Promise<unknown>>,
  resolvedPolicy: ToolConfiguration['policy'],
  resolvedPolicyContext: ToolConfiguration['policyContext'],
): RegistrationToolOptions {
  const options = createToolOptionsBase(configuration, context, resolveExecute);
  applyToolOptions(options, configuration, context, resolvedPolicy, resolvedPolicyContext);
  return options;
}

type RegistrationToolOptions = Omit<
  CreateToolOptions<
    unknown,
    unknown,
    ToolEventsMap,
    readonly string[],
    ToolMetadata | undefined,
    unknown
  >,
  'metadata'
> & { metadata?: ToolMetadata | undefined };

function createToolOptionsBase(
  configuration: ToolConfiguration,
  context: ToolboxRegistrationContext,
  resolveExecute: () => Promise<(params: unknown, context?: unknown) => Promise<unknown>>,
): RegistrationToolOptions {
  return {
    name: configuration.identity.name,
    description: configuration.display.description,
    runtime: context.runtime,
    ...baseToolMetadata(configuration),
    input: configuration.input,
    async execute(params, toolContext) {
      const executeFn = await resolveExecute();
      return executeFn(
        params,
        mergeRuntimeToolContext(context.baseContext, toolContext, {
          dispatchEvent: context.dispatchEvent,
          emit: context.emit,
        }),
      );
    },
  };
}

function baseToolMetadata(configuration: ToolConfiguration) {
  return {
    ...(configuration.identity.namespace !== undefined
      ? { namespace: configuration.identity.namespace }
      : {}),
    ...(configuration.identity.version !== undefined
      ? { version: configuration.identity.version }
      : {}),
    ...(configuration.display.title !== undefined ? { title: configuration.display.title } : {}),
    ...(configuration.display.examples !== undefined
      ? { examples: configuration.display.examples }
      : {}),
    ...(configuration.risk !== undefined ? { risk: configuration.risk } : {}),
    ...(configuration.lifecycle !== undefined ? { lifecycle: configuration.lifecycle } : {}),
  };
}

function applyToolOptions(
  options: RegistrationToolOptions,
  configuration: ToolConfiguration,
  context: ToolboxRegistrationContext,
  resolvedPolicy: ToolConfiguration['policy'],
  resolvedPolicyContext: ToolConfiguration['policyContext'],
): void {
  applyToolMetadata(options, configuration, resolvedPolicy, resolvedPolicyContext);
  applyToolLimits(options, configuration, context);
}

function applyToolMetadata(
  options: RegistrationToolOptions,
  configuration: ToolConfiguration,
  resolvedPolicy: ToolConfiguration['policy'],
  resolvedPolicyContext: ToolConfiguration['policyContext'],
): void {
  if (configuration.tags) options.tags = configuration.tags;
  if (configuration.metadata) options.metadata = configuration.metadata;
  if (configuration.availability) options.availability = configuration.availability;
  if (resolvedPolicy) options.policy = resolvedPolicy;
  if (resolvedPolicyContext) options.policyContext = resolvedPolicyContext;
}

function applyToolLimits(
  options: RegistrationToolOptions,
  configuration: ToolConfiguration,
  context: ToolboxRegistrationContext,
): void {
  const digests = resolveToolDigests(configuration, context.registryDigests);
  if (digests) options.digests = digests;
  const concurrency = resolveToolConcurrency(configuration, context.registryConcurrency);
  if (concurrency !== undefined) options.concurrency = concurrency;
  if (context.telemetryEnabled) options.telemetry = true;
  if (configuration.diagnostics) options.diagnostics = configuration.diagnostics;
  const idempotencyKey = readIdempotencyKey(configuration);
  if (idempotencyKey) options.idempotencyKey = idempotencyKey;
}

function readExecuteSource(configuration: ToolConfiguration): ToolConfiguration['execute'] {
  const rawExecute = Reflect.get(configuration, 'rawExecute');
  return isExecuteFunction(rawExecute) ? rawExecute : configuration.execute;
}

function isExecuteFunction(
  value: unknown,
): value is (params: unknown, context?: unknown) => Promise<unknown> {
  return typeof value === 'function';
}

function readIdempotencyKey(
  configuration: ToolConfiguration,
): ((input: unknown) => string) | undefined {
  const value = Reflect.get(configuration, 'idempotencyKey');
  return isIdempotencyKey(value) ? value : undefined;
}

function isIdempotencyKey(value: unknown): value is (input: unknown) => string {
  return typeof value === 'function';
}

export function createLazyExecuteResolver(
  execute: ToolConfiguration['execute'],
  toolName: string,
): () => Promise<(params: unknown, context?: unknown) => Promise<unknown>> {
  if (typeof execute === 'function') {
    const fn = execute;
    return () => Promise.resolve(fn);
  }
  let resolved: ((params: unknown, context?: unknown) => Promise<unknown>) | undefined;
  let pending: Promise<(params: unknown, context?: unknown) => Promise<unknown>> | undefined;

  return async () => {
    if (resolved) return resolved;
    if (!pending) {
      pending = Promise.resolve(execute)
        .then((value) => {
          if (typeof value !== 'function') {
            throw new TypeError(
              `Tool "${toolName}" has invalid execute. Expected a function or a promise that resolves to a function. If deserializing, ensure createToolbox({ getTool }) returns a function.`,
            );
          }
          resolved = value;
          return value;
        })
        .catch((error) => {
          pending = undefined;
          throw error;
        });
    }
    return pending;
  };
}

export type RegistrationCallbacks = {
  readonly options: ToolboxOptions;
  readonly normalize: (configuration: ToolConfigurationInput) => ToolConfiguration;
  readonly register: (configuration: ToolConfiguration) => void;
};

export function registerConfigurations(
  configurations: ToolboxEntries,
  source: 'deserializing' | 'registration',
  callbacks: RegistrationCallbacks,
): void {
  for (const entry of configurations) {
    const serialized = normalizeRegistration(entry);
    let configuration = callbacks.normalize(
      resolveMissingExecute(serialized, callbacks.options.getTool),
    );
    for (const middleware of callbacks.options.middleware ?? []) {
      const result = middleware(configuration);
      if (isPromise(result)) {
        const message =
          source === 'deserializing'
            ? 'Async middleware is not supported when deserializing. Provide synchronous middleware only.'
            : 'Async middleware is not supported. Provide synchronous middleware only.';
        throw new Error(message);
      }
      configuration = result;
    }
    callbacks.register(
      callbacks.normalize(resolveMissingExecute(configuration, callbacks.options.getTool)),
    );
  }
}
