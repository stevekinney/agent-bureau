import { describe, expect, it } from 'bun:test';

import { CompletableEventTarget } from '../src/completable';

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

describe('CompletableEventTarget', () => {
  describe('completion', () => {
    it('completed starts as false', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      expect(target.completed).toBe(false);
    });

    it('completed becomes true after complete()', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      target.complete();
      expect(target.completed).toBe(true);
    });

    it('complete() is idempotent', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      target.complete();
      expect(() => target.complete()).not.toThrow();
      expect(target.completed).toBe(true);
    });

    it('signal is an AbortSignal', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      expect(target.signal).toBeInstanceOf(AbortSignal);
      expect(target.signal.aborted).toBe(false);
    });

    it('signal is aborted after complete()', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      target.complete();
      expect(target.signal.aborted).toBe(true);
    });
  });

  describe('dispatch', () => {
    it('dispatch works and delivers to addEventListener listeners', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const received: number[] = [];

      target.addEventListener('test', (event) => received.push(event.value));
      target.dispatch(new TestEvent(42));

      expect(received).toEqual([42]);
    });

    it('dispatchEvent also delivers to toObservable subscribers', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const received: string[] = [];

      target.toObservable().subscribe((event) => received.push(event.type));
      target.dispatchEvent(new TestEvent(1));

      expect(received).toEqual(['test']);
      target.complete();
    });
  });

  describe('on()', () => {
    it('returns an ObservableLike for a single event type', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const received: number[] = [];

      const subscription = target.on('test').subscribe((event) => {
        received.push(event.value);
      });

      target.dispatch(new TestEvent(1));
      target.dispatch(new TestEvent(2));

      expect(received).toEqual([1, 2]);

      subscription.unsubscribe();
      target.complete();
    });

    it('completes when the target completes', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      let completed = false;

      target.on('test').subscribe({
        complete() {
          completed = true;
        },
      });

      target.complete();
      expect(completed).toBe(true);
    });
  });

  describe('once()', () => {
    it('fires the listener exactly once', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const received: number[] = [];

      target.once('test', (event) => received.push(event.value));

      target.dispatch(new TestEvent(1));
      target.dispatch(new TestEvent(2));

      expect(received).toEqual([1]);
    });
  });

  describe('subscribe()', () => {
    it('subscribes to a single event type with a callback', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const received: number[] = [];

      const subscription = target.subscribe('test', (event) => {
        received.push(event.value);
      });

      target.dispatch(new TestEvent(5));
      expect(received).toEqual([5]);

      subscription.unsubscribe();
      target.complete();
    });

    it('subscribes with an observer object', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const received: number[] = [];

      const subscription = target.subscribe('test', {
        next(event) {
          received.push(event.value);
        },
      });

      target.dispatch(new TestEvent(10));
      expect(received).toEqual([10]);

      subscription.unsubscribe();
      target.complete();
    });
  });

  describe('toObservable()', () => {
    it('receives ALL dispatched event types', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const types: string[] = [];

      target.toObservable().subscribe((event) => types.push(event.type));

      target.dispatch(new TestEvent(1));
      target.dispatch(new OtherEvent('hello'));
      target.dispatch(new TestEvent(2));

      expect(types).toEqual(['test', 'other', 'test']);
      target.complete();
    });

    it('completes when complete() is called', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      let completed = false;

      target.toObservable().subscribe({
        complete() {
          completed = true;
        },
      });

      target.complete();
      expect(completed).toBe(true);
    });

    it('stops delivering after unsubscribe', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const types: string[] = [];

      const subscription = target.toObservable().subscribe((event) => types.push(event.type));

      target.dispatch(new TestEvent(1));
      subscription.unsubscribe();
      target.dispatch(new TestEvent(2));

      expect(types).toEqual(['test']);
      target.complete();
    });

    it('supports multiple subscribers', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const first: string[] = [];
      const second: string[] = [];

      target.toObservable().subscribe((event) => first.push(event.type));
      target.toObservable().subscribe((event) => second.push(event.type));

      target.dispatch(new TestEvent(1));

      expect(first).toEqual(['test']);
      expect(second).toEqual(['test']);

      target.complete();
    });

    it('subscription.closed reflects state after unsubscribe', () => {
      const target = new CompletableEventTarget<TestEventMap>();

      const subscription = target.toObservable().subscribe(() => {});
      expect(subscription.closed).toBe(false);
      subscription.unsubscribe();
      expect(subscription.closed).toBe(true);

      target.complete();
    });

    it('does not deliver events after complete()', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const types: string[] = [];

      target.toObservable().subscribe((event) => types.push(event.type));

      target.dispatch(new TestEvent(1));
      target.complete();
      target.dispatch(new TestEvent(2));

      expect(types).toEqual(['test']);
    });
  });

  describe('events()', () => {
    it('returns an AsyncIterableIterator that yields events', async () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const iterator = target.events('test');

      target.dispatch(new TestEvent(1));
      target.dispatch(new TestEvent(2));

      const first = await iterator.next();
      const second = await iterator.next();

      expect(first.value.value).toBe(1);
      expect(second.value.value).toBe(2);

      target.complete();
    });

    it('terminates when complete() is called', async () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const iterator = target.events('test');

      target.dispatch(new TestEvent(1));
      target.complete();

      const first = await iterator.next();
      expect(first.value.value).toBe(1);

      const second = await iterator.next();
      expect(second.done).toBe(true);
    });

    it('accepts custom buffer size', async () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const iterator = target.events('test', { bufferSize: 2 });

      target.dispatch(new TestEvent(1));
      target.dispatch(new TestEvent(2));
      target.dispatch(new TestEvent(3)); // dropped

      const first = await iterator.next();
      const second = await iterator.next();

      expect(first.value.value).toBe(1);
      expect(second.value.value).toBe(2);

      target.complete();
    });
  });

  describe('addEventListener with signal auto-cleanup', () => {
    it('listeners using target.signal are removed on complete()', () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const received: number[] = [];

      target.addEventListener('test', (event) => received.push(event.value), {
        signal: target.signal,
      });

      target.dispatch(new TestEvent(1));
      target.complete();
      target.dispatch(new TestEvent(2));

      expect(received).toEqual([1]);
    });
  });

  describe('combined usage', () => {
    it('addEventListener + toObservable + events all work simultaneously', async () => {
      const target = new CompletableEventTarget<TestEventMap>();
      const fromListener: number[] = [];
      const fromObservable: string[] = [];
      const fromIterator: number[] = [];

      target.addEventListener('test', (event) => fromListener.push(event.value), {
        signal: target.signal,
      });

      target.toObservable().subscribe((event) => fromObservable.push(event.type));

      const iterator = target.events('test');

      target.dispatch(new TestEvent(1));
      target.dispatch(new OtherEvent('hello'));
      target.dispatch(new TestEvent(2));

      // Consume iterator
      const first = await iterator.next();
      fromIterator.push(first.value.value);
      const second = await iterator.next();
      fromIterator.push(second.value.value);

      expect(fromListener).toEqual([1, 2]);
      expect(fromObservable).toEqual(['test', 'other', 'test']);
      expect(fromIterator).toEqual([1, 2]);

      target.complete();
    });
  });
});
