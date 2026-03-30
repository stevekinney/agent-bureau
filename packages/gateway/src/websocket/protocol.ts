import type { ServerWebSocket } from 'bun';
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

    if (typeof type !== 'string') {
      return { type: 'error', code: 'INVALID_FRAME', message: 'Missing "type" field' };
    }

    switch (type) {
      case 'subscribe':
        if (typeof runId !== 'string') {
          return { type: 'error', code: 'INVALID_FRAME', message: 'subscribe requires "runId"' };
        }
        return { type: 'subscribe', runId };

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

  /**
   * Broadcasts a stream event to all subscribers of the given run.
   * Converts the StreamEvent into the appropriate ServerFrame before sending.
   */
  broadcastStreamEvent(runId: string, event: StreamEvent): void {
    const frame = streamEventToFrame(runId, event);
    if (frame) {
      this.broadcast(runId, frame);
    }
  }
}

/**
 * Converts a streaming pipeline StreamEvent into a typed ServerFrame
 * suitable for WebSocket transmission. Returns undefined for event
 * types that do not have a corresponding frame.
 */
export function streamEventToFrame(runId: string, event: StreamEvent): ServerFrame | undefined {
  switch (event.type) {
    case 'stream:text-delta':
      return {
        type: 'stream:text-delta',
        runId,
        content: event.content,
        accumulated: event.accumulated,
      };

    case 'stream:tool-call-start':
      return {
        type: 'stream:tool-call-start',
        runId,
        toolName: event.toolName,
        blockId: event.blockId,
      };

    case 'stream:tool-call-delta':
      return {
        type: 'stream:tool-call-delta',
        runId,
        toolName: event.toolName,
        blockId: event.blockId,
        partialArgs: event.partialArguments,
      };

    case 'stream:tool-call-complete':
      return {
        type: 'stream:tool-call-complete',
        runId,
        toolName: event.toolName,
        blockId: event.blockId,
        arguments: event.arguments,
      };

    case 'stream:complete':
      return {
        type: 'stream:complete',
        runId,
        state: event.state,
      };

    case 'stream:error':
      return {
        type: 'stream:error',
        runId,
        error: event.error instanceof Error ? event.error.message : String(event.error),
      };

    default:
      // Other event types (block-start, block-delta, block-complete, usage, start)
      // are internal to the pipeline and not relayed to WebSocket clients.
      return undefined;
  }
}
