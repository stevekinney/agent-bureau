import { registerToolIndexes } from './core/registry';
import type { Embedder } from './core/registry/embeddings';
import { warmToolEmbeddings } from './core/registry/embeddings';
import type { Tool, ToolConfiguration } from './is-tool';
import type { ToolboxEntries, ToolboxOptions } from './toolbox-contracts';
import type { Toolbox } from './toolbox-interface';
import { registerConfigurations } from './toolbox-registration';

export function createToolboxRegistrationState(input: {
  options: ToolboxOptions;
  storedConfigurations: Map<string, ToolConfiguration>;
  toolsById: Map<string, Tool>;
  toolsByName: Map<string, Tool[]>;
  buildTool: (configuration: ToolConfiguration) => Tool;
  normalize: Parameters<typeof registerConfigurations>[2]['normalize'];
  api: Toolbox;
  embedder: Embedder | undefined;
}) {
  const registerConfiguration = (configuration: ToolConfiguration): void => {
    const tool = input.buildTool(configuration);
    if (tool.name !== configuration.name) {
      throw new Error(`Failed to register tool: ${configuration.name}`);
    }
    input.storedConfigurations.set(configuration.id, configuration);
    input.toolsById.set(tool.id, tool);
    const byName = input.toolsByName.get(tool.name) || [];
    const filtered = byName.filter((entry) => entry.id !== tool.id);
    filtered.push(tool);
    input.toolsByName.set(tool.name, filtered);

    registerToolIndexes(input.api, tool, input.toolsById.size);
    if (input.embedder) {
      warmToolEmbeddings(tool, input.embedder, (resolvedTool) => {
        if (input.toolsById.get(resolvedTool.id) !== resolvedTool) return;
        registerToolIndexes(input.api, resolvedTool, input.toolsById.size);
      });
    }
  };

  return {
    registerSerialized(
      configurations: ToolboxEntries,
      source: 'deserializing' | 'registration' = 'deserializing',
    ): void {
      registerConfigurations(configurations, source, {
        options: input.options,
        normalize: input.normalize,
        register: registerConfiguration,
      });
    },
    registerConfiguration,
  };
}
