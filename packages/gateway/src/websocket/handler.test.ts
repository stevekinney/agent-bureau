import type { ServerWebSocket } from 'bun';
import { describe, expect, it } from 'bun:test';

import { LiveFrameBroker } from '../live-events';
import { createWebSocketHandler } from './handler';

/** A minimal fake shaped like the subset of `ServerWebSocket` the handler touches. */
function createFakeWebSocket() {
  let closeCalled = false;
  const sent: string[] = [];
  const ws = {
    send: (data: string) => sent.push(data),
    close: () => {
      closeCalled = true;
    },
  } as unknown as ServerWebSocket<unknown>;
  return { ws, sent, wasCloseCalled: () => closeCalled };
}

describe('createWebSocketHandler — AB-235 shutdown drain', () => {
  it('registers a closeConnection callback on open() that closes the WebSocket', () => {
    const broker = new LiveFrameBroker();
    const handler = createWebSocketHandler({ broker });
    const { ws, wasCloseCalled } = createFakeWebSocket();

    handler.open(ws);
    expect(broker.subscriberCount).toBe(1);

    broker.closeAll();

    expect(wasCloseCalled()).toBe(true);
  });

  it('does not close a WebSocket that was never opened through the handler', () => {
    const broker = new LiveFrameBroker();
    createWebSocketHandler({ broker });

    expect(() => broker.closeAll()).not.toThrow();
    expect(broker.subscriberCount).toBe(0);
  });
});
