import { isHigherPriority, PRIORITY_WEIGHT, type SchedulerPriority } from './types';

/**
 * A priority queue that orders items by scheduler priority (highest first),
 * with FIFO ordering within the same priority level.
 */
export interface PriorityQueue<T extends { priority: SchedulerPriority }> {
  /** Add an item to the queue at its priority position. */
  enqueue(item: T): void;
  /** Remove and return the highest-priority item. Returns undefined if empty. */
  dequeue(): T | undefined;
  /** Return the highest-priority item without removing it. Returns undefined if empty. */
  peek(): T | undefined;
  /** Number of items currently in the queue. */
  readonly size: number;
  /** Returns true if any queued item has strictly higher priority than the given level. */
  hasHigherPriority(than: SchedulerPriority): boolean;
  /** Remove all items from the queue. */
  clear(): void;
  /** Remove the first item that matches the predicate. */
  remove(predicate: (item: T) => boolean): T | undefined;
  /** Iterate over all items in priority order (does not remove them). */
  [Symbol.iterator](): Iterator<T>;
}

/**
 * Creates an array-backed priority queue. The queue is expected to hold
 * a small number of items (tens, not thousands), so insertion sort is
 * appropriate and keeps the implementation simple.
 */
export function createPriorityQueue<T extends { priority: SchedulerPriority }>(): PriorityQueue<T> {
  const items: T[] = [];

  function enqueue(item: T): void {
    const weight = PRIORITY_WEIGHT[item.priority];
    // Find the insertion point: after all items with equal or higher priority.
    let insertAt = items.length;
    for (let i = 0; i < items.length; i++) {
      if (PRIORITY_WEIGHT[items[i]!.priority] > weight) {
        insertAt = i;
        break;
      }
    }
    items.splice(insertAt, 0, item);
  }

  function dequeue(): T | undefined {
    return items.shift();
  }

  function peek(): T | undefined {
    return items[0];
  }

  function hasHigherPriority(than: SchedulerPriority): boolean {
    if (items.length === 0) return false;
    return isHigherPriority(items[0]!.priority, than);
  }

  function clear(): void {
    items.length = 0;
  }

  function remove(predicate: (item: T) => boolean): T | undefined {
    const index = items.findIndex(predicate);
    if (index === -1) {
      return undefined;
    }

    return items.splice(index, 1)[0];
  }

  function* iterator(): Iterator<T> {
    for (const item of items) {
      yield item;
    }
  }

  return {
    enqueue,
    dequeue,
    peek,
    get size() {
      return items.length;
    },
    hasHigherPriority,
    clear,
    remove,
    [Symbol.iterator]: iterator,
  };
}
