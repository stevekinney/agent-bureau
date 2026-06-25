import type { StreamEvent } from 'operative';

import type { ServerFrame } from './types';

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
