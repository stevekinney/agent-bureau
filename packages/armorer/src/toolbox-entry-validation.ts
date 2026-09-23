import { isTool } from './is-tool';
import type { ToolboxEntries, ToolboxEntry } from './toolbox-contracts';

export function toToolboxEntries(values: readonly unknown[]): ToolboxEntries {
  if (values.every(isToolboxEntry)) return values;
  throw new TypeError('Toolbox extension entries are invalid.');
}

function isToolboxEntry(value: unknown): value is ToolboxEntry {
  return isTool(value) || value === null || typeof value === 'object';
}
