import type { ToolboxOptions } from './toolbox-contracts';

export function checkBudget(
  budget: ToolboxOptions['budget'] | undefined,
  startedAt: number,
  calls: number,
  now: number,
): string | undefined {
  if (!budget) return undefined;
  if (typeof budget.maxCalls === 'number' && calls >= budget.maxCalls) {
    return `Budget exceeded: max calls ${budget.maxCalls}`;
  }
  if (typeof budget.maxDurationMs !== 'number') return undefined;
  return now - startedAt >= budget.maxDurationMs
    ? `Budget exceeded: max duration ${budget.maxDurationMs}ms`
    : undefined;
}
