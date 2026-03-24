import { describe, expect, it } from 'bun:test';
import { createEventTarget } from 'event-emission';

import { bindEmitter } from '../src/bind-emitter';

interface TestEvents {
  ping: { value: number };
  pong: { message: string };
}

describe('bindEmitter', () => {
  it('addEventListener receives events', () => {
    const emitter = createEventTarget<TestEvents>();
    const bound = bindEmitter<TestEvents>(emitter);

    const received: number[] = [];
    bound.addEventListener('ping', (event) => {
      received.push(event.detail.value);
    });

    emitter.emit('ping', { value: 42 });

    expect(received).toEqual([42]);
  });

  it('on returns an observable that emits matching events', () => {
    const emitter = createEventTarget<TestEvents>();
    const bound = bindEmitter<TestEvents>(emitter);

    const received: string[] = [];
    bound.on('pong').subscribe({
      next(event) {
        received.push(event.detail.message);
      },
    });

    emitter.emit('pong', { message: 'hello' });

    expect(received).toEqual(['hello']);
  });

  it('once fires the listener only once', () => {
    const emitter = createEventTarget<TestEvents>();
    const bound = bindEmitter<TestEvents>(emitter);

    let callCount = 0;
    bound.once('ping', () => {
      callCount++;
    });

    emitter.emit('ping', { value: 1 });
    emitter.emit('ping', { value: 2 });

    expect(callCount).toBe(1);
  });

  it('subscribe collects events', () => {
    const emitter = createEventTarget<TestEvents>();
    const bound = bindEmitter<TestEvents>(emitter);

    const received: number[] = [];
    const subscription = bound.subscribe('ping', (event) => {
      received.push(event.detail.value);
    });

    emitter.emit('ping', { value: 10 });
    emitter.emit('ping', { value: 20 });

    expect(received).toEqual([10, 20]);

    subscription.unsubscribe();
  });

  it('toObservable receives all events and completes', () => {
    const emitter = createEventTarget<TestEvents>();
    const bound = bindEmitter<TestEvents>(emitter);

    const received: string[] = [];
    let completed = false;

    bound.toObservable().subscribe({
      next(event) {
        received.push(event.type);
      },
      complete() {
        completed = true;
      },
    });

    emitter.emit('ping', { value: 1 });
    emitter.emit('pong', { message: 'hi' });
    emitter.complete();

    expect(received).toEqual(['ping', 'pong']);
    expect(completed).toBe(true);
  });
});
