import { defineTool } from './core/tool-definition';
import type { ToolConfiguration, ToolConfigurationInput } from './is-tool';
import { isTool } from './is-tool';
import type { ToolboxEntry, ToolboxOptions } from './toolbox-contracts';
import { isPromise } from './type-guards';
import { normalizeSchema } from './utilities/schema-normalization';

export function normalizeConfiguration(configuration: ToolConfigurationInput): ToolConfiguration {
  const { name, description } = readIdentityAndDescription(configuration);
  validateExecute(configuration, name);
  const normalizedInput = normalizeSchema(configuration.input);
  const resolvedRisk = configuration.risk ?? deriveRiskFromMetadata(configuration.metadata);
  const definition = defineTool({
    name,
    description,
    ...identityOptions(configuration),
    ...displayOptions(configuration),
    ...metadataOptions(configuration, resolvedRisk),
    input: normalizedInput,
  });
  const result: ToolConfiguration = {
    ...definition,
    input: normalizedInput,
    execute: configuration.execute,
  };
  return addConfigurationOptions(result, configuration);
}

function readIdentityAndDescription(configuration: ToolConfigurationInput): {
  name: string;
  description: string;
} {
  if (!configuration || typeof configuration !== 'object') {
    throw new TypeError('createToolbox entries must be ToolConfiguration objects');
  }
  const name = configuration.name || configuration.identity?.name;
  const description = configuration.description || configuration.display?.description;
  if (!hasText(name) || !hasText(description)) {
    throw new TypeError('createToolbox entries must be ToolConfiguration objects');
  }
  return { name, description };
}

function hasText(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateExecute(configuration: ToolConfigurationInput, name: string): void {
  if (configuration.execute === undefined || configuration.execute === null) {
    throw new TypeError(
      `Tool "${name}" is missing execute. Provide execute or configure createToolbox({ getTool }) to resolve it.`,
    );
  }
  if (typeof configuration.execute !== 'function' && !isPromise(configuration.execute)) {
    throw new TypeError(
      `Tool "${name}" has invalid execute. Expected a function or a promise that resolves to a function.`,
    );
  }
}

function identityOptions(configuration: ToolConfigurationInput) {
  return {
    ...(configuration.identity?.namespace !== undefined
      ? { namespace: configuration.identity.namespace }
      : {}),
    ...(configuration.identity?.version !== undefined
      ? { version: configuration.identity.version }
      : {}),
  };
}

function displayOptions(configuration: ToolConfigurationInput) {
  return {
    ...(configuration.display?.title !== undefined ? { title: configuration.display.title } : {}),
    ...(configuration.display?.examples !== undefined
      ? { examples: configuration.display.examples }
      : {}),
  };
}

function metadataOptions(
  configuration: ToolConfigurationInput,
  resolvedRisk: ToolConfiguration['risk'],
) {
  return {
    ...(configuration.tags ? { tags: configuration.tags } : {}),
    ...(configuration.metadata ? { metadata: configuration.metadata } : {}),
    ...(resolvedRisk !== undefined ? { risk: resolvedRisk } : {}),
    ...(configuration.lifecycle ? { lifecycle: configuration.lifecycle } : {}),
    ...(configuration.availability ? { availability: configuration.availability } : {}),
  };
}

function addConfigurationOptions(
  result: ToolConfiguration,
  configuration: ToolConfigurationInput,
): ToolConfiguration {
  if (configuration.policy) result.policy = configuration.policy;
  if (configuration.policyContext) result.policyContext = configuration.policyContext;
  if (configuration.digests !== undefined) result.digests = configuration.digests;
  if (configuration.concurrency !== undefined) result.concurrency = configuration.concurrency;
  if (configuration.diagnostics) result.diagnostics = configuration.diagnostics;
  const rawExecute = Reflect.get(configuration, 'rawExecute');
  if (rawExecute !== undefined) Reflect.set(result, 'rawExecute', rawExecute);
  const idempotencyKey = Reflect.get(configuration, 'idempotencyKey');
  if (idempotencyKey !== undefined) Reflect.set(result, 'idempotencyKey', idempotencyKey);
  return result;
}

export function normalizeRegistration(entry: ToolboxEntry): ToolConfigurationInput {
  return isTool(entry) ? entry.configuration : entry;
}

export function resolveMissingExecute(
  configuration: ToolConfigurationInput,
  getTool: ToolboxOptions['getTool'],
): ToolConfigurationInput {
  if (!configuration || typeof configuration !== 'object') return configuration;
  if (configuration.execute !== undefined && configuration.execute !== null) return configuration;
  if (!getTool) return configuration;
  const execute = getTool(configuration);
  return { ...configuration, execute };
}

export function deriveRiskFromMetadata(
  metadata: ToolConfiguration['metadata'],
): ToolConfiguration['risk'] {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const risk: NonNullable<ToolConfiguration['risk']> = {};
  if (typeof metadata.mutates === 'boolean') risk.mutates = metadata.mutates;
  if (typeof metadata.readOnly === 'boolean') risk.readOnly = metadata.readOnly;
  if (typeof metadata.dangerous === 'boolean') risk.dangerous = metadata.dangerous;
  return Object.keys(risk).length ? risk : undefined;
}
