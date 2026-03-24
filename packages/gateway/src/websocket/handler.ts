import type { ServerWebSocket } from 'bun';
import type { Store } from 'sentinel';

import type { ServerFrame } from '../types';
import { parseClientFrame, SubscriptionManager } from './protocol';

export interface WebSocketHandlerOptions {
  store: Store;
}

export interface WebSocketHandler {
  subscriptions: SubscriptionManager;
  dispose(): void;
  open(ws: ServerWebSocket<unknown>): void;
  message(ws: ServerWebSocket<unknown>, data: string | Buffer): void;
  close(ws: ServerWebSocket<unknown>): void;
}

export function createWebSocketHandler(options: WebSocketHandlerOptions): WebSocketHandler {
  const subscriptions = new SubscriptionManager();

  const disposeStoreSubscription = options.store.subscribe((_state, action) => {
    const frame: ServerFrame = {
      type: 'event',
      runId: action.runId,
      event: action.type,
      detail: action.detail,
      timestamp: action.timestamp,
    };
    subscriptions.broadcast(action.runId, frame);
  });

  function open(_ws: ServerWebSocket<unknown>): void {
    // Connection tracked on first subscribe
  }

  function message(ws: ServerWebSocket<unknown>, data: string | Buffer): void {
    const frame = parseClientFrame(data);

    if (frame.type === 'error') {
      ws.send(JSON.stringify(frame));
      return;
    }

    switch (frame.type) {
      case 'subscribe': {
        subscriptions.subscribe(ws, frame.runId);
        const response: ServerFrame = { type: 'subscribed', runId: frame.runId };
        ws.send(JSON.stringify(response));
        break;
      }
      case 'unsubscribe': {
        subscriptions.unsubscribe(ws, frame.runId);
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
    subscriptions.removeConnection(ws);
  }

  function dispose(): void {
    disposeStoreSubscription();
  }

  return { subscriptions, dispose, open, message, close };
}
