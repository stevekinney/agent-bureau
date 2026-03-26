import { describe, expect, it } from 'bun:test';

import { createPriorityQueue } from '../../src/scheduler/priority-queue';
import type { SchedulerPriority } from '../../src/scheduler/types';

interface TestItem {
  id: string;
  priority: SchedulerPriority;
}

function item(id: string, priority: SchedulerPriority): TestItem {
  return { id, priority };
}

describe('createPriorityQueue', () => {
  it('dequeues in priority order, not insertion order', () => {
    const queue = createPriorityQueue<TestItem>();

    queue.enqueue(item('ambient-1', 'ambient'));
    queue.enqueue(item('immediate-1', 'immediate'));
    queue.enqueue(item('background-1', 'background'));
    queue.enqueue(item('scheduled-1', 'scheduled'));

    expect(queue.dequeue()?.id).toBe('immediate-1');
    expect(queue.dequeue()?.id).toBe('scheduled-1');
    expect(queue.dequeue()?.id).toBe('background-1');
    expect(queue.dequeue()?.id).toBe('ambient-1');
  });

  it('dequeues same-priority tasks in FIFO order', () => {
    const queue = createPriorityQueue<TestItem>();

    queue.enqueue(item('bg-1', 'background'));
    queue.enqueue(item('bg-2', 'background'));
    queue.enqueue(item('bg-3', 'background'));

    expect(queue.dequeue()?.id).toBe('bg-1');
    expect(queue.dequeue()?.id).toBe('bg-2');
    expect(queue.dequeue()?.id).toBe('bg-3');
  });

  it('maintains FIFO within priority even when interleaved with other priorities', () => {
    const queue = createPriorityQueue<TestItem>();

    queue.enqueue(item('bg-1', 'background'));
    queue.enqueue(item('imm-1', 'immediate'));
    queue.enqueue(item('bg-2', 'background'));
    queue.enqueue(item('imm-2', 'immediate'));

    expect(queue.dequeue()?.id).toBe('imm-1');
    expect(queue.dequeue()?.id).toBe('imm-2');
    expect(queue.dequeue()?.id).toBe('bg-1');
    expect(queue.dequeue()?.id).toBe('bg-2');
  });

  describe('hasHigherPriority', () => {
    it('returns true when queue contains a higher-priority item', () => {
      const queue = createPriorityQueue<TestItem>();
      queue.enqueue(item('imm', 'immediate'));

      expect(queue.hasHigherPriority('scheduled')).toBe(true);
      expect(queue.hasHigherPriority('background')).toBe(true);
      expect(queue.hasHigherPriority('ambient')).toBe(true);
    });

    it('returns false when queue only contains same-priority items', () => {
      const queue = createPriorityQueue<TestItem>();
      queue.enqueue(item('sched', 'scheduled'));

      expect(queue.hasHigherPriority('scheduled')).toBe(false);
    });

    it('returns false when queue only contains lower-priority items', () => {
      const queue = createPriorityQueue<TestItem>();
      queue.enqueue(item('amb', 'ambient'));

      expect(queue.hasHigherPriority('background')).toBe(false);
      expect(queue.hasHigherPriority('scheduled')).toBe(false);
      expect(queue.hasHigherPriority('immediate')).toBe(false);
    });

    it('returns false for an empty queue', () => {
      const queue = createPriorityQueue<TestItem>();
      expect(queue.hasHigherPriority('ambient')).toBe(false);
    });

    it('correctly reports across all lane combinations', () => {
      const priorities: SchedulerPriority[] = ['immediate', 'scheduled', 'background', 'ambient'];

      for (const queued of priorities) {
        for (const than of priorities) {
          const queue = createPriorityQueue<TestItem>();
          queue.enqueue(item('test', queued));

          const expected = priorities.indexOf(queued) < priorities.indexOf(than);
          expect(queue.hasHigherPriority(than)).toBe(expected);
        }
      }
    });
  });

  describe('empty queue behavior', () => {
    it('dequeue returns undefined on empty queue', () => {
      const queue = createPriorityQueue<TestItem>();
      expect(queue.dequeue()).toBeUndefined();
    });

    it('peek returns undefined on empty queue', () => {
      const queue = createPriorityQueue<TestItem>();
      expect(queue.peek()).toBeUndefined();
    });

    it('size is 0 on empty queue', () => {
      const queue = createPriorityQueue<TestItem>();
      expect(queue.size).toBe(0);
    });
  });

  describe('peek', () => {
    it('returns highest-priority item without removing it', () => {
      const queue = createPriorityQueue<TestItem>();
      queue.enqueue(item('bg', 'background'));
      queue.enqueue(item('imm', 'immediate'));

      expect(queue.peek()?.id).toBe('imm');
      expect(queue.peek()?.id).toBe('imm');
      expect(queue.size).toBe(2);
    });
  });

  describe('size', () => {
    it('tracks the number of items', () => {
      const queue = createPriorityQueue<TestItem>();
      expect(queue.size).toBe(0);

      queue.enqueue(item('a', 'immediate'));
      expect(queue.size).toBe(1);

      queue.enqueue(item('b', 'background'));
      expect(queue.size).toBe(2);

      queue.dequeue();
      expect(queue.size).toBe(1);

      queue.dequeue();
      expect(queue.size).toBe(0);
    });
  });

  describe('clear', () => {
    it('empties the queue', () => {
      const queue = createPriorityQueue<TestItem>();
      queue.enqueue(item('a', 'immediate'));
      queue.enqueue(item('b', 'scheduled'));
      queue.enqueue(item('c', 'background'));

      queue.clear();

      expect(queue.size).toBe(0);
      expect(queue.dequeue()).toBeUndefined();
      expect(queue.peek()).toBeUndefined();
    });
  });

  describe('iteration', () => {
    it('yields items in priority order', () => {
      const queue = createPriorityQueue<TestItem>();
      queue.enqueue(item('amb', 'ambient'));
      queue.enqueue(item('imm', 'immediate'));
      queue.enqueue(item('bg', 'background'));
      queue.enqueue(item('sched', 'scheduled'));

      const ids = [...queue].map((i) => i.id);
      expect(ids).toEqual(['imm', 'sched', 'bg', 'amb']);
    });

    it('does not remove items from the queue', () => {
      const queue = createPriorityQueue<TestItem>();
      queue.enqueue(item('a', 'immediate'));
      queue.enqueue(item('b', 'background'));

      const _items = [...queue];
      expect(queue.size).toBe(2);
    });

    it('yields nothing for an empty queue', () => {
      const queue = createPriorityQueue<TestItem>();
      const items = [...queue];
      expect(items).toEqual([]);
    });
  });
});
