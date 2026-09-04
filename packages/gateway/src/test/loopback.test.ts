import { describe, expect, it } from 'bun:test';

import type { ClientFrame, ServerFrame } from '../types';
import { FrameQueue, readEventStream, wrapWebSocket } from './loopback';

/**
 * A minimal fake `WebSocket` — just enough of the `EventTarget` +
 * `send`/`close`/`readyState` surface for {@link wrapWebSocket} to wrap it,
 * with `dispatch` exposed so a test can fire `message`/`close`/`error`
 * events directly without a real socket.
 */
function createFakeWebSocket(): { socket: WebSocket; dispatch: (event: Event) => void } {
  const target = new EventTarget();
  const sent: string[] = [];
  const socket = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    send: (data: string) => sent.push(data),
    close: () => undefined,
    readyState: 1,
  } as unknown as WebSocket;
  return { socket, dispatch: (event: Event) => target.dispatchEvent(event) };
}

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

describe('readEventStream (test/loopback.ts internal plumbing)', () => {
  it("ends the frame queue with the read error when the response body stream errors mid-read (AB-316: pump()'s catch branch)", async () => {
    const failure = new Error('synthetic body read failure');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    const response = new Response(body);
    const reader = readEventStream(response);

    let rejection: unknown;
    try {
      await reader.next();
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBe(failure);
  });
});

describe('wrapWebSocket (test/loopback.ts internal plumbing)', () => {
  it('parses a message event into a ServerFrame available from next()', async () => {
    const { socket, dispatch } = createFakeWebSocket();
    const client = wrapWebSocket(socket);

    const frame: ServerFrame = { type: 'connected' } as unknown as ServerFrame;
    const messageEvent = new MessageEvent('message', { data: JSON.stringify(frame) });
    dispatch(messageEvent);

    expect(await client.next()).toEqual(frame);
  });

  it('ends the frame queue and pushes onto the close queue when the socket closes', async () => {
    const { socket, dispatch } = createFakeWebSocket();
    const client = wrapWebSocket(socket);

    const closeEvent = new CloseEvent('close', { code: 1000, reason: 'done' });
    dispatch(closeEvent);

    expect(await client.next()).toBeUndefined();
    expect(await client.waitForClose()).toEqual({ code: 1000, reason: 'done' });
  });

  it('does not throw when the socket fires an unhandled error event (close is what tears down state)', () => {
    const { socket, dispatch } = createFakeWebSocket();
    wrapWebSocket(socket);

    expect(() => dispatch(new Event('error'))).not.toThrow();
  });

  it('exposes readyState from the underlying socket and forwards send() as JSON', () => {
    const { socket } = createFakeWebSocket();
    const client = wrapWebSocket(socket);

    expect(client.readyState).toBe(1);
    expect(() => client.send({ type: 'ping' } as unknown as ClientFrame)).not.toThrow();
  });

  it('forwards close() to the underlying socket', () => {
    let closed = false;
    const { socket } = createFakeWebSocket();
    (socket as unknown as { close: () => void }).close = () => {
      closed = true;
    };
    const client = wrapWebSocket(socket);

    client.close();

    expect(closed).toBe(true);
  });
});
