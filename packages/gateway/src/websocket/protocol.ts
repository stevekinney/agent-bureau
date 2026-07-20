import { streamEventToFrame } from 'bureau';

import type { ClientFrame, ServerFrame } from '../types';

/**
 * Frame parsing and conversion for the gateway's WebSocket protocol. The
 * production fan-out path that broadcasts these frames to subscribed
 * connections is `LiveFrameBroker` (`../live-events`), wired into
 * `createGateway`.
 */

/**
 * Parses a raw WebSocket message into a typed ClientFrame, or returns
 * an error frame if the message is malformed.
 */
export function parseClientFrame(data: string | Buffer): ClientFrame | ServerFrame {
  try {
    const raw = typeof data === 'string' ? data : data.toString();
    const parsedJson: unknown = JSON.parse(raw);

    if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
      return { type: 'error', code: 'INVALID_FRAME', message: 'Frame must be a JSON object' };
    }

    const parsed = parsedJson as Record<string, unknown>;
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
        return {
          type: 'subscribe',
          runId,
          since:
            typeof since === 'number' && Number.isSafeInteger(since) && since >= 0
              ? since
              : undefined,
        };

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

// Re-exported for existing consumers of `./protocol` and `./index` — the
// canonical implementation lives in `bureau` (`streamEventToFrame` /
// `StreamFrame`) so this door package and the brain package never drift.
export { streamEventToFrame };
