import type { CachedToolResult, ToolResultCacheEntry } from './types';

export const RESULT_UNDEFINED_SENTINEL = '__armorerResultUndefined';

type CacheEntryRecord = Record<string, unknown>;

function isRecord(value: unknown): value is CacheEntryRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeStartedEntry(
  value: CacheEntryRecord,
  defaultTTL: number | undefined,
): ToolResultCacheEntry | undefined {
  if (
    value['status'] !== 'started' ||
    typeof value['toolName'] !== 'string' ||
    typeof value['startedAt'] !== 'number'
  ) {
    return undefined;
  }

  return {
    status: 'started',
    toolName: value['toolName'],
    startedAt: value['startedAt'],
    ttl: typeof value['ttl'] === 'number' ? value['ttl'] : (defaultTTL ?? 0),
    ...(typeof value['attemptId'] === 'string' ? { attemptId: value['attemptId'] } : {}),
    ...(typeof value['leaseExpiresAt'] === 'number'
      ? { leaseExpiresAt: value['leaseExpiresAt'] }
      : {}),
    ...(typeof value['absoluteDeadline'] === 'number'
      ? { absoluteDeadline: value['absoluteDeadline'] }
      : {}),
    ...(typeof value['inputDigest'] === 'string' ? { inputDigest: value['inputDigest'] } : {}),
  };
}

function decodeCompletedEntry(
  value: CacheEntryRecord,
  defaultTTL: number | undefined,
): CachedToolResult | undefined {
  if (!isCompletedEntry(value)) {
    return undefined;
  }

  return {
    status: 'completed',
    result: value[RESULT_UNDEFINED_SENTINEL] === true ? undefined : value['result'],
    toolName: value['toolName'],
    executedAt: value['executedAt'],
    ttl: typeof value['ttl'] === 'number' ? value['ttl'] : (defaultTTL ?? 0),
    ...(typeof value['expiresAt'] === 'number' ? { expiresAt: value['expiresAt'] } : {}),
    ...(typeof value['policyRevision'] === 'string'
      ? { policyRevision: value['policyRevision'] }
      : {}),
    ...(typeof value['input'] === 'string' ? { input: value['input'] } : {}),
    ...(value['inputWasUndefined'] === true ? { inputWasUndefined: true as const } : {}),
  };
}

function isCompletedEntry(
  value: CacheEntryRecord,
): value is CacheEntryRecord & { toolName: string; executedAt: number } {
  const hasResult = 'result' in value || value[RESULT_UNDEFINED_SENTINEL] === true;
  const hasSupportedStatus = value['status'] === undefined || value['status'] === 'completed';
  return (
    hasSupportedStatus &&
    hasResult &&
    typeof value['toolName'] === 'string' &&
    typeof value['executedAt'] === 'number'
  );
}

export function decodeEntry(
  value: unknown,
  defaultTTL: number | undefined,
): ToolResultCacheEntry | undefined {
  if (!isRecord(value)) return undefined;
  return decodeStartedEntry(value, defaultTTL) ?? decodeCompletedEntry(value, defaultTTL);
}

export function encodeEntry(entry: ToolResultCacheEntry): Record<string, unknown> {
  if (entry.status === 'started' || entry.result !== undefined) {
    return entry;
  }

  const { result: _result, ...encoded } = entry;
  return {
    ...encoded,
    [RESULT_UNDEFINED_SENTINEL]: true,
  };
}

export function isExpired(entry: ToolResultCacheEntry, now: () => number): boolean {
  if (entry.status === 'started' || entry.ttl === 0) return false;
  return now() > (entry.expiresAt ?? entry.executedAt + entry.ttl);
}

export function createCompletedEntry(
  result: CachedToolResult,
  ttl: number | undefined,
  defaultTTL: number | undefined,
  now: () => number,
): CachedToolResult {
  const effectiveTTL = ttl ?? result.ttl ?? defaultTTL;
  return {
    ...result,
    status: 'completed',
    ...(effectiveTTL !== undefined ? { ttl: effectiveTTL } : {}),
    ...(effectiveTTL !== undefined && effectiveTTL !== 0
      ? { expiresAt: now() + effectiveTTL }
      : {}),
  };
}
