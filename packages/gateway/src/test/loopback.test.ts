import { describe, expect, it } from 'bun:test';

import { FrameQueue } from './loopback';

describe('FrameQueue (test/loopback.ts internal plumbing)', () => {
  it('resolves push() against a pending next(signal) call and detaches the abort listener (PR #469)', async () => {
    const queue = new FrameQueue<string>();
    const controller = new AbortController();

    const pending = queue.next(controller.signal);
    queue.push('frame-1');

    expect(await pending).toBe('frame-1');
    // The abort listener registered for the settled waiter must have been
    // detached — aborting afterward must not throw or affect a later call.
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it('rejects a pending next(signal) call when end(error) fires while the signal has not aborted, and detaches its abort listener', async () => {
    const queue = new FrameQueue<string>();
    const controller = new AbortController();

    const pending = queue.next(controller.signal);
    const failure = new Error('stream ended unexpectedly');
    queue.end(failure);

    let rejection: unknown;
    try {
      await pending;
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBe(failure);
    // No listener leak: the abort event on this now-settled signal has
    // nothing left to notify.
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it('resolves a pending next(signal) call with undefined when end() fires with no error', async () => {
    const queue = new FrameQueue<string>();
    const controller = new AbortController();

    const pending = queue.next(controller.signal);
    queue.end();

    expect(await pending).toBeUndefined();
  });

  it('rejects immediately when next(signal) is called with an already-aborted signal', async () => {
    const queue = new FrameQueue<string>();
    const controller = new AbortController();
    controller.abort(new Error('already gone'));

    let rejection: unknown;
    try {
      await queue.next(controller.signal);
    } catch (error) {
      rejection = error;
    }

    expect((rejection as Error).message).toBe('already gone');
  });

  it('rejects a pending next(signal) call when its signal aborts', async () => {
    const queue = new FrameQueue<string>();
    const controller = new AbortController();

    const pending = queue.next(controller.signal);
    controller.abort(new Error('caller gave up'));

    let rejection: unknown;
    try {
      await pending;
    } catch (error) {
      rejection = error;
    }

    expect((rejection as Error).message).toBe('caller gave up');
  });

  it('resolves next() with a buffered value without waiting, when called with no signal', async () => {
    const queue = new FrameQueue<string>();
    queue.push('buffered');

    expect(await queue.next()).toBe('buffered');
  });

  it('resolves next() with undefined once ended with no queued values and no error, when called with no signal', async () => {
    const queue = new FrameQueue<string>();
    queue.end();

    expect(await queue.next()).toBeUndefined();
  });

  it('rejects next() once ended with an error and no queued values, when called with no signal', async () => {
    const queue = new FrameQueue<string>();
    const failure = new Error('boom');
    queue.end(failure);

    let rejection: unknown;
    try {
      await queue.next();
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBe(failure);
  });
});
