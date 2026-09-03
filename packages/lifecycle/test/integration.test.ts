import { describe, expect, it } from 'bun:test';

import { CompletableEventTarget } from '../src/completable';
import { ForwardedEvent, forwardEvents } from '../src/forwarded-event';

class PingEvent extends Event {
  static readonly type = 'ping' as const;
  readonly seq: number;

  constructor(seq: number) {
    super(PingEvent.type);
    this.seq = seq;
  }

  // Narrows the inherited `Event.type: string` to the literal so `dispatch`'s
  // `M[K] & { type: K }` constraint can match this event to its map key.
  override get type(): typeof PingEvent.type {
    return PingEvent.type;
  }
}

class PongEvent extends Event {
  static readonly type = 'pong' as const;
  readonly data: string;

  constructor(data: string) {
    super(PongEvent.type);
    this.data = data;
  }

  override get type(): typeof PongEvent.type {
    return PongEvent.type;
  }
}

// `type` aliases, not `interface`s: only object type literals get TypeScript's
// implicit index signature, letting these satisfy `EventMap`'s
// `Record<string, Event>` constraint without a redundant explicit index signature.
type SourceMap = {
  [PingEvent.type]: PingEvent;
  [PongEvent.type]: PongEvent;
};

type TargetMap = {
  'source.ping': ForwardedEvent<PingEvent>;
  'source.pong': ForwardedEvent<PongEvent>;
};

describe('integration', () => {
  it('dispatch + addEventListener + toObservable + events all work simultaneously', async () => {
    const target = new CompletableEventTarget<SourceMap>();
    const fromListener: number[] = [];
    const fromObservable: string[] = [];

    // addEventListener
    target.addEventListener('ping', (event) => fromListener.push(event.seq), {
      signal: target.signal,
    });

    // toObservable
    target.toObservable().subscribe((event) => fromObservable.push(event.type));

    // events (async iterator)
    const iterator = target.events('ping');

    // Dispatch
    target.dispatch(new PingEvent(1));
    target.dispatch(new PongEvent('hello'));
    target.dispatch(new PingEvent(2));

    // Consume iterator
    const first = await iterator.next();
    const second = await iterator.next();

    expect(fromListener).toEqual([1, 2]);
    expect(fromObservable).toEqual(['ping', 'pong', 'ping']);
    expect(first.value.seq).toBe(1);
    expect(second.value.seq).toBe(2);

    // Complete terminates everything
    target.complete();

    const done = await iterator.next();
    expect(done.done).toBe(true);
  });

  it('ForwardedEvent flow across two targets', () => {
    const source = new CompletableEventTarget<SourceMap>();
    const target = new CompletableEventTarget<TargetMap>();

    const received: Array<{ type: string; originalType: string }> = [];

    target.addEventListener('source.ping', (event) => {
      received.push({
        type: event.type,
        originalType: event.originalEvent.type,
      });
    });

    target.addEventListener('source.pong', (event) => {
      received.push({
        type: event.type,
        originalType: event.originalEvent.type,
      });
    });

    forwardEvents(source, target, 'source');

    source.dispatch(new PingEvent(1));
    source.dispatch(new PongEvent('test'));

    expect(received).toEqual([
      { type: 'source.ping', originalType: 'ping' },
      { type: 'source.pong', originalType: 'pong' },
    ]);

    source.complete();
    target.complete();
  });

  it('forwarded events are visible via toObservable on the target', () => {
    const source = new CompletableEventTarget<SourceMap>();
    const target = new CompletableEventTarget<TargetMap>();
    const observed: string[] = [];

    target.toObservable().subscribe((event) => observed.push(event.type));

    forwardEvents(source, target, 'source');

    source.dispatch(new PingEvent(1));
    source.dispatch(new PongEvent('data'));

    expect(observed).toEqual(['source.ping', 'source.pong']);

    source.complete();
    target.complete();
  });

  it('completing the source stops forwarding', () => {
    const source = new CompletableEventTarget<SourceMap>();
    const target = new CompletableEventTarget<TargetMap>();
    const observed: string[] = [];

    target.toObservable().subscribe((event) => observed.push(event.type));

    forwardEvents(source, target, 'source');

    source.dispatch(new PingEvent(1));
    source.complete();
    source.dispatch(new PingEvent(2));

    // Only first event forwarded — source completed before second dispatch
    expect(observed).toEqual(['source.ping']);

    target.complete();
  });

  it('on() observable completes when target completes', () => {
    const target = new CompletableEventTarget<SourceMap>();
    let completed = false;
    const values: number[] = [];

    target.on('ping').subscribe({
      next(event) {
        values.push(event.seq);
      },
      complete() {
        completed = true;
      },
    });

    target.dispatch(new PingEvent(1));
    target.dispatch(new PingEvent(2));
    target.complete();

    expect(values).toEqual([1, 2]);
    expect(completed).toBe(true);
  });

  it('subscribe() is a shorthand that works like on().subscribe()', () => {
    const target = new CompletableEventTarget<SourceMap>();
    const values: number[] = [];

    const subscription = target.subscribe('ping', (event) => values.push(event.seq));

    target.dispatch(new PingEvent(10));
    target.dispatch(new PingEvent(20));

    expect(values).toEqual([10, 20]);

    subscription.unsubscribe();
    target.dispatch(new PingEvent(30));

    expect(values).toEqual([10, 20]);
    target.complete();
  });
});
