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
        options.broker.subscribe(ws, frame.runId);
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
