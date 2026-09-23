import { serializeToolDefinition } from './core/serialization';
import type { Tool, ToolConfiguration } from './is-tool';
import { isToolAvailable as checkToolAvailability } from './toolbox-availability';
import type { ToolboxEntries } from './toolbox-contracts';
import { createImportedExecute } from './toolbox-imports';
import { createToolboxViews, requireRuntimeToolContext } from './toolbox-views';

export function createToolboxViewState(input: {
  toolsById: Map<string, Tool>;
  getTool: (nameOrId: string) => Tool | undefined;
  storedConfigurations: Map<string, ToolConfiguration>;
  baseContext: Record<string, unknown>;
}) {
  return createToolboxViews<ToolboxEntries>({
    listTools: () => Array.from(input.toolsById.values()),
    listAvailableTools: async () => {
      const available = await Promise.all(
        Array.from(input.toolsById.values()).map((tool) =>
          checkToolAvailability(tool, input.baseContext),
        ),
      );
      return Array.from(input.toolsById.values()).filter(
        (tool, index) => available[index] === true && input.getTool(tool.name) === tool,
      );
    },
    listDefinitions: () => Array.from(input.toolsById.values()),
    listAvailableDefinitions: async () => {
      const available = await Promise.all(
        Array.from(input.toolsById.values()).map((tool) =>
          checkToolAvailability(tool, input.baseContext),
        ),
      );
      return Array.from(input.toolsById.values()).filter(
        (tool, index) => available[index] === true && input.getTool(tool.name) === tool,
      );
    },
    getTool: input.getTool,
    createImportedExecute,
    storedConfigurations: () => Array.from(input.storedConfigurations.values()),
    serializeConfiguration: (configuration) => serializeToolDefinition(configuration),
    runTool: (tool, parameters, toolContext) =>
      tool.run(parameters, requireRuntimeToolContext(toolContext, tool, parameters)),
  });
}
