import { defineTool } from './core/tool-definition';
import type { ToolConfiguration, ToolDigestOptions } from './is-tool';
import type { ImportedToolboxOptions, ToolboxOptions } from './toolbox-contracts';
import type { Toolbox } from './toolbox-interface';
import type { ImportedToolConfiguration } from './toolbox-type-inference';
import { normalizeConcurrency } from './utilities/concurrency';

export type ImportedToolboxFactory = (
  configurations: readonly ToolConfiguration[],
  options: ToolboxOptions,
) => Toolbox;

export function createImportedToolbox(
  importedConfigurations: ImportedToolConfiguration | readonly ImportedToolConfiguration[],
  options: ImportedToolboxOptions,
  createToolbox: ImportedToolboxFactory,
): Toolbox {
  const resolvedOptions = resolveImportedToolboxOptions(options);
  const configurations = Array.isArray(importedConfigurations)
    ? importedConfigurations
    : [importedConfigurations];

  return createToolbox(
    configurations.map((configuration) =>
      materializeImportedToolConfiguration(configuration, resolvedOptions),
    ),
    resolvedOptions,
  );
}

export function materializeImportedToolConfiguration(
  configuration: ImportedToolConfiguration,
  options: ToolboxOptions,
): ToolConfiguration {
  const definition = defineTool({
    name: configuration.name,
    description: configuration.description,
    ...importedIdentity(configuration),
    ...importedDisplay(configuration),
    ...importedMetadata(configuration),
    input: configuration.input,
  });

  const importedConfiguration = {
    ...definition,
    input: configuration.input,
  };

  Object.assign(importedConfiguration, importedOptions(configuration));

  const execute =
    configuration.execute ??
    options.getTool?.(importedConfiguration) ??
    createImportedExecute(configuration.name);

  return { ...importedConfiguration, execute };
}

function importedIdentity(configuration: ImportedToolConfiguration) {
  return {
    ...(configuration.namespace !== undefined ? { namespace: configuration.namespace } : {}),
    ...(configuration.version !== undefined ? { version: configuration.version } : {}),
  };
}

function importedDisplay(configuration: ImportedToolConfiguration) {
  return {
    ...(configuration.title !== undefined ? { title: configuration.title } : {}),
    ...(configuration.examples !== undefined ? { examples: configuration.examples } : {}),
  };
}

function importedMetadata(configuration: ImportedToolConfiguration) {
  return {
    ...(configuration.tags !== undefined ? { tags: configuration.tags } : {}),
    ...(configuration.metadata !== undefined ? { metadata: configuration.metadata } : {}),
    ...(configuration.risk !== undefined ? { risk: configuration.risk } : {}),
    ...(configuration.lifecycle !== undefined ? { lifecycle: configuration.lifecycle } : {}),
    ...(configuration.availability !== undefined
      ? { availability: configuration.availability }
      : {}),
  };
}

function importedOptions(configuration: ImportedToolConfiguration) {
  return {
    ...(configuration.policy ? { policy: configuration.policy } : {}),
    ...(configuration.policyContext ? { policyContext: configuration.policyContext } : {}),
    ...(configuration.digests !== undefined ? { digests: configuration.digests } : {}),
    ...(configuration.concurrency !== undefined ? { concurrency: configuration.concurrency } : {}),
    ...(configuration.diagnostics ? { diagnostics: configuration.diagnostics } : {}),
  };
}

export function createImportedExecute(toolName: string): ToolConfiguration['execute'] {
  const message = `Imported tool "${toolName}" does not have an execute implementation. Provide createToolbox.fromProvider(..., { sourceToolbox }), createToolbox.from<Provider>Tools(..., { getTool }), or supply execute before creating the toolbox.`;
  return () => Promise.reject(new Error(message));
}

export function resolveImportedToolboxOptions(options: ImportedToolboxOptions): ToolboxOptions {
  const { sourceToolbox, ...rest } = options;
  if (!sourceToolbox) return rest;
  return { ...rest, getTool: rest.getTool ?? sourceToolbox.asExecuteResolver() };
}

export function resolveToolConcurrency(
  configuration: ToolConfiguration,
  registryConcurrency?: number,
): number | undefined {
  const direct = normalizeConcurrency(configuration.concurrency);
  if (direct !== undefined) return direct;
  const metadataConcurrency = normalizeConcurrency(configuration.metadata?.concurrency);
  if (metadataConcurrency !== undefined) return metadataConcurrency;
  return normalizeConcurrency(registryConcurrency);
}

export function resolveToolDigests(
  configuration: ToolConfiguration,
  registryDigests?: ToolDigestOptions,
): ToolDigestOptions | undefined {
  return configuration.digests ?? registryDigests;
}
