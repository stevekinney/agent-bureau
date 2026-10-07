/**
 * COR-851 — the cost estimator a goal attempt's run was started with, as it is
 * persisted beside the run's recovery record.
 *
 * An attempt is priced after it ends, possibly in another process and against a
 * catalog that has since moved to another revision of the agent or dropped it.
 * The estimator is therefore not re-resolved then: the start records the exact
 * `RunOptions.costEstimation` the run was configured with (`null` for none,
 * which is a selection, not an absence), and every later pricing reads that.
 *
 * The record is plain JSON on purpose, so it round-trips exactly. The same
 * check guards the write and the decode, so a value the decoder would refuse is
 * never written.
 */

import type { RunOptions } from '@lostgradient/operative';

/** The persisted selection: the run's estimator, or `null` when it declared none. */
export type GoalAttemptCostEstimation = NonNullable<RunOptions['costEstimation']> | null;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPrice = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function isModelPricing(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const known = [
    'promptCostPerMillionTokens',
    'completionCostPerMillionTokens',
    'cacheWriteCostPerMillionTokens',
    'cacheReadCostPerMillionTokens',
  ];
  if (!Object.keys(value).every((key) => known.includes(key))) return false;
  if (!isPrice(value['promptCostPerMillionTokens'])) return false;
  if (!isPrice(value['completionCostPerMillionTokens'])) return false;
  return ['cacheWriteCostPerMillionTokens', 'cacheReadCostPerMillionTokens'].every(
    (key) => value[key] === undefined || isPrice(value[key]),
  );
}

/** Whether `value` is a persistable selection: `null`, or `{ model, pricing? }` with plain-JSON prices. */
export function isGoalAttemptCostEstimation(value: unknown): value is GoalAttemptCostEstimation {
  if (value === null) return true;
  if (!isPlainRecord(value)) return false;
  if (!Object.keys(value).every((key) => key === 'model' || key === 'pricing')) return false;
  if (typeof value['model'] !== 'string' || value['model'].length === 0) return false;
  const pricing = value['pricing'];
  if (pricing === undefined) return true;
  if (!isPlainRecord(pricing)) return false;
  if (!Object.keys(pricing).every((key) => key === 'customPricing')) return false;
  const custom = pricing['customPricing'];
  return (
    custom === undefined ||
    (isPlainRecord(custom) && Object.values(custom).every((entry) => isModelPricing(entry)))
  );
}
