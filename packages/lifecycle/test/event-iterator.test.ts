import { describe, expect, it } from 'bun:test';

import { eventIterator } from '../src/event-iterator';

class TestEvent extends Event {
  static readonly type = 'test' as const;
  readonly value: number;

  constructor(value: number) {
    super(TestEvent.type);
    this.value = value;
  }
}

describe('eventIterator', () => {
  it('yields events in order', async () => {
    const target = new EventTarget();
    const controller = new AbortController();
    const iterator = eventIterator<TestEvent>(target, 'test', { signal: controller.signal });

    target.dispatchEvent(new TestEvent(1));
    target.dispatchEvent(new TestEvent(2));
    target.dispatchEvent(new TestEvent(3));

    const first = await iterator.next();
    const second = await iterator.next();
    const third = await iterator.next();

    expect(first.value.value).toBe(1);
    expect(second.value.value).toBe(2);
    expect(third.value.value).toBe(3);

    controller.abort();
  });

  it('buffers events when consumer is slower than producer', async () => {
    const target = new EventTarget();
    const controller = new AbortController();
    const iterator = eventIterator<TestEvent>(target, 'test', { signal: controller.signal });

    // Produce 5 events before consuming
    for (let i = 0; i < 5; i++) {
      target.dispatchEvent(new TestEvent(i));
    }

    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await iterator.next();
      results.push(result.value.value);
    }

    expect(results).toEqual([0, 1, 2, 3, 4]);
    controller.abort();
  });

  it('drops latest events when buffer is full', async () => {
    const target = new EventTarget();
    const controller = new AbortController();
    const iterator = eventIterator<TestEvent>(target, 'test', {
      signal: controller.signal,
      bufferSize: 3,
    });

    // Produce 5 events into a buffer of size 3
    for (let i = 0; i < 5; i++) {
      target.dispatchEvent(new TestEvent(i));
    }

    const results: number[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await iterator.next();
      results.push(result.value.value);
    }

    // Only the first 3 should have been buffered; 4th and 5th dropped
    expect(results).toEqual([0, 1, 2]);
    controller.abort();
  });

  it('terminates when signal is aborted', async () => {
    const target = new EventTarget();
    const controller = new AbortController();
    const iterator = eventIterator<TestEvent>(target, 'test', { signal: controller.signal });

    controller.abort();

    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  it('resolves a pending pull when an event arrives', async () => {
    const target = new EventTarget();
    const controller = new AbortController();
    const iterator = eventIterator<TestEvent>(target, 'test', { signal: controller.signal });

    // Start pulling before any events — creates a pending resolve
    const pullPromise = iterator.next();

    // Now dispatch — should resolve the pending pull
    target.dispatchEvent(new TestEvent(99));

    const result = await pullPromise;
    expect(result.done).toBe(false);
    expect(result.value.value).toBe(99);

    controller.abort();
  });

  it('terminates a pending pull when signal is aborted', async () => {
    const target = new EventTarget();
    const controller = new AbortController();
    const iterator = eventIterator<TestEvent>(target, 'test', { signal: controller.signal });

    // Start pulling before any events - this will pend
    const pullPromise = iterator.next();

    // Abort while pull is pending
    controller.abort();

    const result = await pullPromise;
    expect(result.done).toBe(true);
  });

  it('terminates when iterator.return() is called', async () => {
    const target = new EventTarget();
    const iterator = eventIterator<TestEvent>(target, 'test');

    target.dispatchEvent(new TestEvent(1));
    const first = await iterator.next();
    expect(first.value.value).toBe(1);

    const returned = await iterator.return!(undefined as unknown as TestEvent);
    expect(returned.done).toBe(true);

    // Subsequent calls should also return done
    const after = await iterator.next();
    expect(after.done).toBe(true);
  });

  it('works with for-await-of', async () => {
    const target = new EventTarget();
    const controller = new AbortController();
    const iterator = eventIterator<TestEvent>(target, 'test', { signal: controller.signal });

    target.dispatchEvent(new TestEvent(10));
    target.dispatchEvent(new TestEvent(20));

    const results: number[] = [];

    // Use queueMicrotask to abort after consuming
    setTimeout(() => controller.abort(), 10);

    for await (const event of iterator) {
      results.push(event.value);
      if (results.length === 2) break;
    }

    expect(results).toEqual([10, 20]);
  });

  it('returns done immediately when signal is already aborted', async () => {
    const target = new EventTarget();
    const controller = new AbortController();
    controller.abort();

    const iterator = eventIterator<TestEvent>(target, 'test', { signal: controller.signal });

    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  it('supports concurrent iterators on the same target and type', async () => {
    const target = new EventTarget();
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    const iteratorA = eventIterator<TestEvent>(target, 'test', { signal: controllerA.signal });
    const iteratorB = eventIterator<TestEvent>(target, 'test', { signal: controllerB.signal });

    target.dispatchEvent(new TestEvent(42));

    const resultA = await iteratorA.next();
    const resultB = await iteratorB.next();

    expect(resultA.value.value).toBe(42);
    expect(resultB.value.value).toBe(42);

    controllerA.abort();
    controllerB.abort();
  });

  it('does not deliver events after termination', async () => {
    const target = new EventTarget();
    const controller = new AbortController();
    const iterator = eventIterator<TestEvent>(target, 'test', { signal: controller.signal });

    target.dispatchEvent(new TestEvent(1));
    controller.abort();
    target.dispatchEvent(new TestEvent(2));

    const first = await iterator.next();
    // First event was buffered before abort
    expect(first.value.value).toBe(1);

    const second = await iterator.next();
    expect(second.done).toBe(true);
  });

  it('works without signal option', async () => {
    const target = new EventTarget();
    const iterator = eventIterator<TestEvent>(target, 'test');

    target.dispatchEvent(new TestEvent(7));
    const result = await iterator.next();
    expect(result.value.value).toBe(7);

    // Clean up via return
    await iterator.return!(undefined as unknown as TestEvent);
  });

  it('uses default buffer size of 256', async () => {
    const target = new EventTarget();
    const controller = new AbortController();
    const iterator = eventIterator<TestEvent>(target, 'test', { signal: controller.signal });

    // Dispatch 300 events
    for (let i = 0; i < 300; i++) {
      target.dispatchEvent(new TestEvent(i));
    }

    // Should get first 256
    const results: number[] = [];
    for (let i = 0; i < 256; i++) {
      const result = await iterator.next();
      results.push(result.value.value);
    }

    expect(results).toHaveLength(256);
    expect(results[0]).toBe(0);
    expect(results[255]).toBe(255);

    controller.abort();
  });

  it('is an AsyncIterable (has Symbol.asyncIterator)', () => {
    const target = new EventTarget();
    const iterator = eventIterator<TestEvent>(target, 'test');
    expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
  });
});
