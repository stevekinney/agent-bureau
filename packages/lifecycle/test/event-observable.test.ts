import { describe, expect, it } from 'bun:test';

import { allEventsObservable, eventObservable } from '../src/event-observable';

class TestEvent extends Event {
  static readonly type = 'test' as const;
  readonly value: number;

  constructor(value: number) {
    super(TestEvent.type);
    this.value = value;
  }
}

class OtherEvent extends Event {
  static readonly type = 'other' as const;
  readonly message: string;

  constructor(message: string) {
    super(OtherEvent.type);
    this.message = message;
  }
}

describe('eventObservable', () => {
  it('delivers events via subscribe(next) shorthand', () => {
    const target = new EventTarget();
    const received: number[] = [];

    const subscription = eventObservable<TestEvent>(target, 'test').subscribe((event) => {
      received.push(event.value);
    });

    target.dispatchEvent(new TestEvent(1));
    target.dispatchEvent(new TestEvent(2));

    expect(received).toEqual([1, 2]);
    subscription.unsubscribe();
  });

  it('delivers events via subscribe(observer) form', () => {
    const target = new EventTarget();
    const received: number[] = [];

    const subscription = eventObservable<TestEvent>(target, 'test').subscribe({
      next(event) {
        received.push(event.value);
      },
    });

    target.dispatchEvent(new TestEvent(42));
    expect(received).toEqual([42]);
    subscription.unsubscribe();
  });

  it('stops delivery after unsubscribe', () => {
    const target = new EventTarget();
    const received: number[] = [];

    const subscription = eventObservable<TestEvent>(target, 'test').subscribe((event) => {
      received.push(event.value);
    });

    target.dispatchEvent(new TestEvent(1));
    subscription.unsubscribe();
    target.dispatchEvent(new TestEvent(2));

    expect(received).toEqual([1]);
  });

  it('reflects closed state on subscription', () => {
    const target = new EventTarget();
    const subscription = eventObservable<TestEvent>(target, 'test').subscribe(() => {});

    expect(subscription.closed).toBe(false);
    subscription.unsubscribe();
    expect(subscription.closed).toBe(true);
  });

  it('calls complete() when signal is aborted', () => {
    const target = new EventTarget();
    const controller = new AbortController();
    let completed = false;

    eventObservable<TestEvent>(target, 'test', { signal: controller.signal }).subscribe({
      complete() {
        completed = true;
      },
    });

    expect(completed).toBe(false);
    controller.abort();
    expect(completed).toBe(true);
  });

  it('calls start() synchronously with the subscription', () => {
    const target = new EventTarget();
    let startedClosed: boolean | undefined;

    eventObservable<TestEvent>(target, 'test').subscribe({
      start(subscription) {
        startedClosed = subscription.closed;
      },
    });

    expect(startedClosed).toBe(false);
  });

  it('supports multiple subscribers', () => {
    const target = new EventTarget();
    const first: number[] = [];
    const second: number[] = [];

    const observable = eventObservable<TestEvent>(target, 'test');
    const sub1 = observable.subscribe((event) => first.push(event.value));
    const sub2 = observable.subscribe((event) => second.push(event.value));

    target.dispatchEvent(new TestEvent(7));

    expect(first).toEqual([7]);
    expect(second).toEqual([7]);

    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  it('does not emit after signal abort', () => {
    const target = new EventTarget();
    const controller = new AbortController();
    const received: number[] = [];

    eventObservable<TestEvent>(target, 'test', { signal: controller.signal }).subscribe((event) => {
      received.push(event.value);
    });

    target.dispatchEvent(new TestEvent(1));
    controller.abort();
    target.dispatchEvent(new TestEvent(2));

    expect(received).toEqual([1]);
  });

  it('unsubscribe is idempotent', () => {
    const target = new EventTarget();
    const subscription = eventObservable<TestEvent>(target, 'test').subscribe(() => {});

    subscription.unsubscribe();
    expect(() => subscription.unsubscribe()).not.toThrow();
    expect(subscription.closed).toBe(true);
  });

  it('works with empty observer', () => {
    const target = new EventTarget();
    const subscription = eventObservable<TestEvent>(target, 'test').subscribe({});

    target.dispatchEvent(new TestEvent(1));
    expect(subscription.closed).toBe(false);

    subscription.unsubscribe();
  });

  it('works with no arguments to subscribe', () => {
    const target = new EventTarget();
    const subscription = eventObservable<TestEvent>(target, 'test').subscribe();

    target.dispatchEvent(new TestEvent(1));
    expect(subscription.closed).toBe(false);

    subscription.unsubscribe();
  });

  it('calls complete() on unsubscribe', () => {
    const target = new EventTarget();
    let completed = false;

    const subscription = eventObservable<TestEvent>(target, 'test').subscribe({
      complete() {
        completed = true;
      },
    });

    subscription.unsubscribe();
    expect(completed).toBe(true);
  });

  it('if start() synchronously unsubscribes, no listener is added', () => {
    const target = new EventTarget();
    const received: number[] = [];

    eventObservable<TestEvent>(target, 'test').subscribe({
      start(subscription) {
        subscription.unsubscribe();
      },
      next(event) {
        received.push(event.value);
      },
    });

    target.dispatchEvent(new TestEvent(1));
    expect(received).toEqual([]);
  });
});

describe('allEventsObservable', () => {
  it('receives events of all listed types', () => {
    const target = new EventTarget();
    const received: string[] = [];

    const subscription = allEventsObservable<TestEvent | OtherEvent>(target, [
      'test',
      'other',
    ]).subscribe((event) => {
      received.push(event.type);
    });

    target.dispatchEvent(new TestEvent(1));
    target.dispatchEvent(new OtherEvent('hello'));
    target.dispatchEvent(new TestEvent(2));

    expect(received).toEqual(['test', 'other', 'test']);
    subscription.unsubscribe();
  });

  it('stops delivery on signal abort', () => {
    const target = new EventTarget();
    const controller = new AbortController();
    const received: string[] = [];

    allEventsObservable<TestEvent | OtherEvent>(target, ['test', 'other'], {
      signal: controller.signal,
    }).subscribe((event) => {
      received.push(event.type);
    });

    target.dispatchEvent(new TestEvent(1));
    controller.abort();
    target.dispatchEvent(new OtherEvent('after'));

    expect(received).toEqual(['test']);
  });

  it('stops delivery and reflects closed after unsubscribe', () => {
    const target = new EventTarget();
    const received: string[] = [];

    const subscription = allEventsObservable<TestEvent>(target, ['test']).subscribe((event) => {
      received.push(event.type);
    });

    target.dispatchEvent(new TestEvent(1));
    expect(subscription.closed).toBe(false);

    subscription.unsubscribe();
    expect(subscription.closed).toBe(true);

    target.dispatchEvent(new TestEvent(2));
    expect(received).toEqual(['test']);
  });

  it('calls complete() on signal abort', () => {
    const target = new EventTarget();
    const controller = new AbortController();
    let completed = false;

    allEventsObservable<TestEvent>(target, ['test'], { signal: controller.signal }).subscribe({
      complete() {
        completed = true;
      },
    });

    controller.abort();
    expect(completed).toBe(true);
  });
});
