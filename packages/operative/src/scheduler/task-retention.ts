import type { RuntimeServices } from '@lostgradient/lifecycle';

import type { RunResult } from '../types';

type TaskOutcome = PromiseSettledResult<RunResult | null>;
type TimerHandle = ReturnType<RuntimeServices['timers']['setTimeout']>;

type RetentionRecord =
  | { readonly kind: 'terminal'; readonly outcome: TaskOutcome; timer?: TimerHandle }
  | { readonly kind: 'tombstone'; timer: TimerHandle };

export type RetainedLookup =
  | { readonly kind: 'terminal'; readonly outcome: TaskOutcome }
  | { readonly kind: 'expired' }
  | undefined;

export interface TaskRetention {
  /** Records a settled outcome, arming the eviction timer when a window is set. */
  record(taskId: string, outcome: TaskOutcome): void;
  /** Drops any entry or tombstone for the id and cancels its timer. */
  forget(taskId: string): void;
  lookup(taskId: string): RetainedLookup;
  /** Cancels every timer and clears all entries and tombstones. Emits nothing. */
  purge(): void;
}

/**
 * In-memory, time-aware retention of settled scheduler outcomes. With a finite
 * window each id holds at most one timer: the entry's timer is replaced by the
 * tombstone's at eviction. An unset window keeps outcomes indefinitely and arms
 * no timers.
 */
export function createTaskRetention(options: {
  runtime: RuntimeServices;
  retentionWindowMs: number | undefined;
  onEntryEvicted: (taskId: string) => void;
}): TaskRetention {
  const { runtime, retentionWindowMs, onEntryEvicted } = options;
  const records = new Map<string, RetentionRecord>();

  function forget(taskId: string): void {
    const existing = records.get(taskId);
    if (!existing) return;
    if (existing.timer !== undefined) runtime.timers.clearTimeout(existing.timer);
    records.delete(taskId);
  }

  function armTombstone(taskId: string, window: number): void {
    const timer = runtime.timers.setTimeout(() => {
      records.delete(taskId);
    }, window);
    records.set(taskId, { kind: 'tombstone', timer });
  }

  function record(taskId: string, outcome: TaskOutcome): void {
    forget(taskId);
    if (retentionWindowMs === undefined) {
      records.set(taskId, { kind: 'terminal', outcome });
      return;
    }
    const window = retentionWindowMs;
    const timer = runtime.timers.setTimeout(() => {
      armTombstone(taskId, window);
      onEntryEvicted(taskId);
    }, window);
    records.set(taskId, { kind: 'terminal', outcome, timer });
  }

  function lookup(taskId: string): RetainedLookup {
    const found = records.get(taskId);
    if (!found) return undefined;
    return found.kind === 'terminal'
      ? { kind: 'terminal', outcome: found.outcome }
      : { kind: 'expired' };
  }

  function purge(): void {
    for (const entry of records.values()) {
      if (entry.timer !== undefined) runtime.timers.clearTimeout(entry.timer);
    }
    records.clear();
  }

  return { record, forget, lookup, purge };
}
