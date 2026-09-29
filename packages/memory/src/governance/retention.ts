import type { MemoryClass, MemoryRetentionRule } from './policy';

/**
 * When a record's retention period ends under COR-806's per-class rules, or
 * `undefined` when its class has no clock: working memory ends with its run,
 * identity and preference memory is deleted only by its subject, and resource
 * memory follows its source. Retention expiry runs through the same deletion
 * plan and receipt as a requested deletion.
 */
export function retentionExpiry(
  record: { memoryClass: MemoryClass; eventAt: number; invalidatedAt?: number },
  rules: Readonly<Record<MemoryClass, MemoryRetentionRule>>,
): number | undefined {
  const rule = rules[record.memoryClass];
  if (rule.kind === 'duration') return record.eventAt + rule.milliseconds;
  if (rule.kind === 'until-superseded' && record.invalidatedAt !== undefined) {
    return record.invalidatedAt + rule.supersededMilliseconds;
  }
  return undefined;
}
