import type { ServerWebSocket } from 'bun';

import type { LiveFrameBroker } from '../live-events';
import type { ServerFrame } from '../types';
import { parseClientFrame } from './protocol';

/**
 * Per-connection state attached to the socket at upgrade time (AB-305) —
 * see `adapters/bun-adapter.ts`'s `server.upgrade(r, { data: { privileged } })`.
 */
export interface GatewayWebSocketData {
  privileged: boolean;
}

export interface WebSocketHandlerOptions {
  broker: LiveFrameBroker;
}

export interface WebSocketHandler {
  dispose(): void;
  open(ws: ServerWebSocket<GatewayWebSocketData>): void;
  message(ws: ServerWebSocket<GatewayWebSocketData>, data: string | Buffer): void;
  close(ws: ServerWebSocket<GatewayWebSocketData>): void;
}

export function createWebSocketHandler(options: WebSocketHandlerOptions): WebSocketHandler {
  function open(ws: ServerWebSocket<GatewayWebSocketData>): void {
    options.broker.addSubscriber(
      ws,
      (frame) => {
        ws.send(JSON.stringify(frame));
      },
      // AB-235: register a close callback so gateway shutdown's
      // `LiveFrameBroker.closeAll()` can send a WebSocket close frame to
      // this connection as part of draining before the adapter's own
      // `stop()` is force-closed.
      // AB-305: fail closed — a socket whose `data` is missing or
      // malformed (a fake in a test, an upgrade path that forgot to set
      // it) is treated as non-privileged, never the reverse. Redaction is
      // the default; privilege is opt-in.
      { closeConnection: () => ws.close(), privileged: ws.data?.privileged === true },
    );
  }

  function message(ws: ServerWebSocket<GatewayWebSocketData>, data: string | Buffer): void {
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
        // AB-219: the existing pong response itself is unchanged; this only
        // feeds the application-level connection watchdog the fact that
        // the transport-level keepalive fired.
        options.broker.recordTransportKeepalive(ws);
        const response: ServerFrame = { type: 'pong' };
        ws.send(JSON.stringify(response));
        break;
      }
    }
  }

  function close(ws: ServerWebSocket<GatewayWebSocketData>): void {
    options.broker.removeSubscriber(ws);
  }

  function dispose(): void {
    // Broker lifecycle is owned by the gateway.
  }

  return { dispose, open, message, close };
}
