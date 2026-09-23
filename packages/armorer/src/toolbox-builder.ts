import type { Tool, ToolConfiguration } from './is-tool';
import type { ToolboxOptions } from './toolbox-contracts';
import { buildDefaultTool, type ToolboxRegistrationContext } from './toolbox-registration';

export function createToolBuilder(
  options: ToolboxOptions,
  context: ToolboxRegistrationContext,
  dispatchEvent: (event: Event) => boolean,
  emit: (type: string, detail: unknown) => boolean,
  baseContext: Record<string, unknown>,
): (configuration: ToolConfiguration) => Tool {
  if (typeof options.toolFactory === 'function') {
    const toolFactory = options.toolFactory;
    return (configuration) =>
      toolFactory(configuration, {
        dispatchEvent,
        emit,
        baseContext,
        buildDefaultTool: (toolConfiguration) => buildDefaultTool(toolConfiguration, context),
      });
  }
  return (configuration) => buildDefaultTool(configuration, context);
}
