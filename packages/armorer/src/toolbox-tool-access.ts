import type { Tool } from './is-tool';

export function createToolAccessor(
  toolsById: Map<string, Tool>,
  toolsByName: Map<string, Tool[]>,
): (nameOrId: string) => Tool | undefined {
  return (nameOrId) => {
    if (toolsById.has(nameOrId)) return toolsById.get(nameOrId);
    const matches = toolsByName.get(nameOrId);
    if (matches && matches.length > 0) return matches[matches.length - 1];
    return undefined;
  };
}
