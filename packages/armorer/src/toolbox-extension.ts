import type { ApprovalStateStore, GrantStateStore } from './approval-binding';
import type { ToolConfiguration } from './is-tool';
import type { ToolboxEntries, ToolboxEntry, ToolboxOptions } from './toolbox-contracts';
import { toToolboxEntries } from './toolbox-entry-validation';
import { isToolbox } from './toolbox-instance';
import type { Toolbox } from './toolbox-interface';

export function createToolboxExtension(input: {
  baseContext: Record<string, unknown>;
  storedConfigurations: Map<string, ToolConfiguration>;
  options: ToolboxOptions;
  approvalStateStore: ApprovalStateStore | undefined;
  grantStateStore: GrantStateStore | undefined;
  createToolbox: (entries: ToolboxEntries, options: ToolboxOptions) => Toolbox;
}): (...entries: readonly unknown[]) => Toolbox {
  return (...entries) => {
    const context = { ...input.baseContext };
    const mergedEntries: ToolboxEntry[] = Array.from(input.storedConfigurations.values());
    if (entries.length === 1 && isToolbox(entries[0])) {
      const other = entries[0];
      Object.assign(context, other.getContext?.() ?? {});
      mergedEntries.push(...other.toJSON());
    } else if (entries.length > 0) {
      mergedEntries.push(...toToolboxEntries(entries));
    }
    return input.createToolbox(mergedEntries, {
      ...input.options,
      ...(input.approvalStateStore ? { approvalStateStore: input.approvalStateStore } : {}),
      ...(input.grantStateStore ? { grantStateStore: input.grantStateStore } : {}),
      context,
    });
  };
}
