import type { ServerWebSocket } from 'bun';

import type { LiveFrameBroker } from '../live-events';
import type { ServerFrame } from '../types';
import { parseClientFrame } from './protocol';

export interface WebSocketHandlerOptions {
  broker: LiveFrameBroker;
}

export interface WebSocketHandler {
  dispose(): void;
  open(ws: ServerWebSocket<unknown>): void;
  message(ws: ServerWebSocket<unknown>, data: string | Buffer): void;
  close(ws: ServerWebSocket<unknown>): void;
}

export function createWebSocketHandler(options: WebSocketHandlerOptions): WebSocketHandler {
  function open(ws: ServerWebSocket<unknown>): void {
    options.broker.addSubscriber(ws, (frame) => {
      ws.send(JSON.stringify(frame));
    });
  }

  function message(ws: ServerWebSocket<unknown>, data: string | Buffer): void {
    const frame = parseClientFrame(data);

    if (frame.type === 'error') {
      ws.send(JSON.stringify(frame));
      return;
    }

    switch (frame.type) {
      case 'subscribe': {
        // AB-15: `subscribe` adds the connection to the live set and (in the
        // same synchronous call) returns any buffered frames newer than
        // `frame.since`. Sent before the `subscribed` ack so a client that
        // treats the ack as "now caught up" sees replay first.
        const replayFrames = options.broker.subscribe(ws, frame.runId, frame.since);
        for (const replayFrame of replayFrames) {
          ws.send(JSON.stringify(replayFrame));
        }
        const response: ServerFrame = { type: 'subscribed', runId: frame.runId };
        ws.send(JSON.stringify(response));
        break;
      }
      case 'unsubscribe': {
        options.broker.unsubscribe(ws, frame.runId);
        const response: ServerFrame = { type: 'unsubscribed', runId: frame.runId };
        ws.send(JSON.stringify(response));
        break;
      }
      case 'ping': {
        const response: ServerFrame = { type: 'pong' };
        ws.send(JSON.stringify(response));
        break;
      }
    }
  }

  function close(ws: ServerWebSocket<unknown>): void {
    options.broker.removeSubscriber(ws);
  }

  function dispose(): void {
    // Broker lifecycle is owned by the gateway.
  }

  return { dispose, open, message, close };
}
