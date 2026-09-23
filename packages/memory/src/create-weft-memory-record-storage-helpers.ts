import {
  encodeStorageKeyComponent,
  type Storage,
  storageConditionalBatch,
  storageDeletePrefix,
  storageKeys,
  WEFT_RESERVED_KEY_PREFIXES,
} from '@lostgradient/weft';

import type { MemoryRecord, MemoryRecordScope } from './memory-record-storage';

export function requireRecordDedupeKey(record: MemoryRecord): string {
  const dedupeKey = record.metadata['dedupeKey'];
  if (typeof dedupeKey !== 'string' || dedupeKey.length === 0) {
    throw new Error('record.metadata.dedupeKey must be a non-empty string.');
  }
  return dedupeKey;
}

export function recordDedupeKey(record: MemoryRecord): string | undefined {
  const dedupeKey = record.metadata['dedupeKey'];
  return typeof dedupeKey === 'string' ? dedupeKey : undefined;
}

export function validateMemoryKeyPrefix(keyPrefix: string): void {
  if (keyPrefix.length === 0) throw new Error('keyPrefix must be a non-empty string.');
  for (const reserved of WEFT_RESERVED_KEY_PREFIXES) {
    if (keyPrefix.startsWith(reserved) || reserved.startsWith(keyPrefix)) {
      throw new Error(
        `keyPrefix "${keyPrefix}" collides with the reserved Weft prefix "${reserved}".`,
      );
    }
  }
}

export function scopePrefix(keyPrefix: string, scope: MemoryRecordScope): string {
  if (scope.namespace.length === 0) throw new Error('namespace must be a non-empty string.');
  const tenant = encodeStorageKeyComponent(scope.tenantId ?? '');
  const namespace = encodeStorageKeyComponent(scope.namespace);
  return `${keyPrefix}t:${tenant}:n:${namespace}:`;
}

export function recordKey(keyPrefix: string, scope: MemoryRecordScope, id: string): string {
  return `${scopePrefix(keyPrefix, scope)}${encodeStorageKeyComponent(id)}`;
}

export function dedupeScopePrefix(keyPrefix: string, scope: MemoryRecordScope): string {
  if (scope.namespace.length === 0) throw new Error('namespace must be a non-empty string.');
  const tenant = encodeStorageKeyComponent(scope.tenantId ?? '');
  const namespace = encodeStorageKeyComponent(scope.namespace);
  return `${keyPrefix}dedupe:t:${tenant}:n:${namespace}:`;
}

export function dedupeIndexKey(
  keyPrefix: string,
  scope: MemoryRecordScope,
  dedupeKey: string,
): string {
  return `${dedupeScopePrefix(keyPrefix, scope)}${encodeStorageKeyComponent(dedupeKey)}`;
}

export async function backfillDedupeIndexes(
  storage: Storage,
  keyPrefix: string,
  readActive: (key: string) => Promise<MemoryRecord | undefined>,
  getRecordDedupeKey: (record: MemoryRecord) => string | undefined,
): Promise<void> {
  await storageDeletePrefix(storage, `${keyPrefix}dedupe:`);
  const candidates: Array<{
    dedupeKey: string;
    key: string;
    record: MemoryRecord;
    scope: MemoryRecordScope;
  }> = [];
  for await (const key of storageKeys(storage, `${keyPrefix}t:`)) {
    const record = await readActive(key);
    if (record === undefined) continue;
    const dedupeKey = getRecordDedupeKey(record);
    if (dedupeKey === undefined || dedupeKey.length === 0) continue;
    candidates.push({
      dedupeKey,
      key,
      record,
      scope: {
        ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
        namespace: record.namespace,
      },
    });
  }
  const sortedCandidates = candidates.toSorted((a, b) => {
    const tenantOrder = (a.record.tenantId ?? '').localeCompare(b.record.tenantId ?? '');
    if (tenantOrder !== 0) return tenantOrder;
    const namespaceOrder = a.record.namespace.localeCompare(b.record.namespace);
    if (namespaceOrder !== 0) return namespaceOrder;
    const keyOrder = a.dedupeKey.localeCompare(b.dedupeKey);
    if (keyOrder !== 0) return keyOrder;
    const createdOrder = a.record.createdAt - b.record.createdAt;
    return createdOrder !== 0 ? createdOrder : a.record.id.localeCompare(b.record.id);
  });
  const seen = new Set<string>();
  const mutations: Parameters<typeof storageConditionalBatch>[2] = [];
  for (const candidate of sortedCandidates) {
    const groupKey = `${candidate.record.tenantId ?? ''}\0${candidate.record.namespace}\0${candidate.dedupeKey}`;
    if (seen.has(groupKey)) {
      mutations.push({ type: 'delete', key: candidate.key });
      continue;
    }
    seen.add(groupKey);
    mutations.push({
      type: 'put',
      key: dedupeIndexKey(keyPrefix, candidate.scope, candidate.dedupeKey),
      value: new TextEncoder().encode(candidate.record.id),
    });
  }
  if (mutations.length > 0) await storageConditionalBatch(storage, [], mutations);
}
