import type { ServerWebSocket } from 'bun';
import { streamEventToFrame } from 'bureau';
import type { StreamEvent } from 'operative';

import type { ClientFrame, ServerFrame } from '../types';

/**
 * Parses a raw WebSocket message into a typed ClientFrame, or returns
 * an error frame if the message is malformed.
 */
export function parseClientFrame(data: string | Buffer): ClientFrame | ServerFrame {
  try {
    const raw = typeof data === 'string' ? data : data.toString();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const type = parsed['type'];
    const runId = parsed['runId'];
    const since = parsed['since'];

    if (typeof type !== 'string') {
      return { type: 'error', code: 'INVALID_FRAME', message: 'Missing "type" field' };
    }

    switch (type) {
      case 'subscribe':
        if (typeof runId !== 'string') {
          return { type: 'error', code: 'INVALID_FRAME', message: 'subscribe requires "runId"' };
        }
        return { type: 'subscribe', runId, since: typeof since === 'number' ? since : undefined };

      case 'unsubscribe':
        if (typeof runId !== 'string') {
          return {
            type: 'error',
            code: 'INVALID_FRAME',
            message: 'unsubscribe requires "runId"',
          };
        }
        return { type: 'unsubscribe', runId };

      case 'ping':
        return { type: 'ping' };

      default:
        return { type: 'error', code: 'UNKNOWN_TYPE', message: `Unknown type: ${type}` };
    }
  } catch {
    return { type: 'error', code: 'PARSE_ERROR', message: 'Invalid JSON' };
  }
}

/**
 * Manages WebSocket subscriptions. Tracks which connections are subscribed
 * to which run IDs, enabling efficient broadcast and cleanup.
 */
export class SubscriptionManager {
  /** Connections → subscribed run IDs */
  private connectionToRuns = new Map<ServerWebSocket<unknown>, Set<string>>();
  /** Run IDs → subscribed connections */
  private runToConnections = new Map<string, Set<ServerWebSocket<unknown>>>();
  /**
   * Per-run monotonic sequence counter, mirroring the one `create-bureau.ts`
   * stamps onto live frames (AB-15). This manager is a standalone broadcast
   * path (not wired into the production `createGateway` — see
   * `LiveFrameBroker`), so it keeps its own counter rather than depending on
   * the bureau's.
   */
  private readonly runSequenceCounters = new Map<string, number>();

  subscribe(ws: ServerWebSocket<unknown>, runId: string): void {
    let runs = this.connectionToRuns.get(ws);
    if (!runs) {
      runs = new Set();
      this.connectionToRuns.set(ws, runs);
    }
    runs.add(runId);

    let connections = this.runToConnections.get(runId);
    if (!connections) {
      connections = new Set();
      this.runToConnections.set(runId, connections);
    }
    connections.add(ws);
  }

  unsubscribe(ws: ServerWebSocket<unknown>, runId: string): void {
    const runs = this.connectionToRuns.get(ws);
    if (runs) {
      runs.delete(runId);
      if (runs.size === 0) this.connectionToRuns.delete(ws);
    }

    const connections = this.runToConnections.get(runId);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) this.runToConnections.delete(runId);
    }
  }

  removeConnection(ws: ServerWebSocket<unknown>): void {
    const runs = this.connectionToRuns.get(ws);
    if (!runs) return;

    for (const runId of runs) {
      const connections = this.runToConnections.get(runId);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) this.runToConnections.delete(runId);
      }
    }

    this.connectionToRuns.delete(ws);
  }

  broadcast(runId: string, frame: ServerFrame): void {
    const connections = this.runToConnections.get(runId);
    if (!connections) return;

    const message = JSON.stringify(frame);
    for (const ws of connections) {
      ws.send(message);
    }
  }

  getSubscriptions(ws: ServerWebSocket<unknown>): ReadonlySet<string> {
    return this.connectionToRuns.get(ws) ?? new Set();
  }

  getSubscriberCount(runId: string): number {
    return this.runToConnections.get(runId)?.size ?? 0;
  }

  private nextRunSeq(runId: string): number {
    const next = (this.runSequenceCounters.get(runId) ?? 0) + 1;
    this.runSequenceCounters.set(runId, next);
    return next;
  }

  /**
   * Broadcasts a stream event to all subscribers of the given run.
   * Converts the StreamEvent into the appropriate ServerFrame before sending.
   */
  broadcastStreamEvent(runId: string, event: StreamEvent): void {
    const frame = streamEventToFrame(runId, event);
    if (frame) {
      this.broadcast(runId, { ...frame, runSeq: this.nextRunSeq(runId) });
    }
  }
}

// Re-exported for existing consumers of `./protocol` and `./index` — the
// canonical implementation lives in `bureau` (`streamEventToFrame` /
// `StreamFrame`) so this door package and the brain package never drift.
export { streamEventToFrame };
