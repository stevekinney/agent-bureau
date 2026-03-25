import { describe, expect, it } from 'bun:test';

import { TypedEventTarget } from '../src/typed-event-target';

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

interface TestEventMap {
  [TestEvent.type]: TestEvent;
  [OtherEvent.type]: OtherEvent;
}

describe('TypedEventTarget', () => {
  it('can be constructed with no arguments', () => {
    const target = new TypedEventTarget<TestEventMap>();
    expect(target).toBeInstanceOf(EventTarget);
    expect(target).toBeInstanceOf(TypedEventTarget);
  });

  it('delivers typed events to addEventListener listeners', () => {
    const target = new TypedEventTarget<TestEventMap>();
    const received: TestEvent[] = [];

    target.addEventListener('test', (event) => {
      received.push(event);
    });

    target.dispatch(new TestEvent(42));

    expect(received).toHaveLength(1);
    expect(received[0]!.value).toBe(42);
  });

  it('delivers the exact Event subclass instance', () => {
    const target = new TypedEventTarget<TestEventMap>();
    const original = new TestEvent(99);
    let received: TestEvent | undefined;

    target.addEventListener('test', (event) => {
      received = event;
    });

    target.dispatch(original);

    expect(received).toBe(original);
  });

  it('stops delivery after removeEventListener', () => {
    const target = new TypedEventTarget<TestEventMap>();
    const received: TestEvent[] = [];

    const listener = (event: TestEvent) => {
      received.push(event);
    };

    target.addEventListener('test', listener);
    target.dispatch(new TestEvent(1));
    target.removeEventListener('test', listener);
    target.dispatch(new TestEvent(2));

    expect(received).toHaveLength(1);
    expect(received[0]!.value).toBe(1);
  });

  it('supports { once: true } option', () => {
    const target = new TypedEventTarget<TestEventMap>();
    const received: TestEvent[] = [];

    target.addEventListener(
      'test',
      (event) => {
        received.push(event);
      },
      { once: true },
    );

    target.dispatch(new TestEvent(1));
    target.dispatch(new TestEvent(2));

    expect(received).toHaveLength(1);
    expect(received[0]!.value).toBe(1);
  });

  it('supports { signal } option for cleanup', () => {
    const target = new TypedEventTarget<TestEventMap>();
    const controller = new AbortController();
    const received: TestEvent[] = [];

    target.addEventListener(
      'test',
      (event) => {
        received.push(event);
      },
      { signal: controller.signal },
    );

    target.dispatch(new TestEvent(1));
    controller.abort();
    target.dispatch(new TestEvent(2));

    expect(received).toHaveLength(1);
    expect(received[0]!.value).toBe(1);
  });

  it('supports multiple listeners for the same type', () => {
    const target = new TypedEventTarget<TestEventMap>();
    const first: number[] = [];
    const second: number[] = [];

    target.addEventListener('test', (event) => first.push(event.value));
    target.addEventListener('test', (event) => second.push(event.value));

    target.dispatch(new TestEvent(7));

    expect(first).toEqual([7]);
    expect(second).toEqual([7]);
  });

  it('supports multiple event types on one target', () => {
    const target = new TypedEventTarget<TestEventMap>();
    const testValues: number[] = [];
    const otherMessages: string[] = [];

    target.addEventListener('test', (event) => testValues.push(event.value));
    target.addEventListener('other', (event) => otherMessages.push(event.message));

    target.dispatch(new TestEvent(1));
    target.dispatch(new OtherEvent('hello'));
    target.dispatch(new TestEvent(2));

    expect(testValues).toEqual([1, 2]);
    expect(otherMessages).toEqual(['hello']);
  });

  it('does not deliver events to listeners of different types', () => {
    const target = new TypedEventTarget<TestEventMap>();
    const received: OtherEvent[] = [];

    target.addEventListener('other', (event) => received.push(event));
    target.dispatch(new TestEvent(1));

    expect(received).toHaveLength(0);
  });

  it('dispatch returns true when no listener calls preventDefault', () => {
    const target = new TypedEventTarget<TestEventMap>();
    const result = target.dispatch(new TestEvent(1));
    expect(result).toBe(true);
  });

  it('passes null listener without throwing', () => {
    const target = new TypedEventTarget<TestEventMap>();
    expect(() => target.addEventListener('test', null)).not.toThrow();
    expect(() => target.removeEventListener('test', null)).not.toThrow();
  });

  it('allows subclass properties to be accessed on the event', () => {
    const target = new TypedEventTarget<TestEventMap>();
    let value: number | undefined;
    let message: string | undefined;

    target.addEventListener('test', (event) => {
      value = event.value;
    });
    target.addEventListener('other', (event) => {
      message = event.message;
    });

    target.dispatch(new TestEvent(42));
    target.dispatch(new OtherEvent('world'));

    expect(value).toBe(42);
    expect(message).toBe('world');
  });

  it('untyped dispatchEvent still works', () => {
    const target = new TypedEventTarget<TestEventMap>();
    const received: Event[] = [];

    target.addEventListener('test', (event) => received.push(event));
    target.dispatchEvent(new TestEvent(5));

    expect(received).toHaveLength(1);
  });

  it('supports boolean option for addEventListener (capture phase)', () => {
    const target = new TypedEventTarget<TestEventMap>();
    const received: number[] = [];

    target.addEventListener('test', (event) => received.push(event.value), true);
    target.dispatch(new TestEvent(10));

    expect(received).toEqual([10]);
  });
});
