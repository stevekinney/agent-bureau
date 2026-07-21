/**
 * Tests for `streamEventToFrame`: the pure mapping from a streaming
 * pipeline `StreamEvent` to the WebSocket/SSE-facing `StreamFrame`. This
 * function had no test coverage at all before this file — it's a plain
 * switch with no I/O, no timers, and every branch is trivially reachable.
 */
import { describe, expect, it } from 'bun:test';
import type { StreamEvent } from 'operative';

import { streamEventToFrame } from './websocket-frames';

describe('streamEventToFrame', () => {
  it('maps a stream:text-delta event to a text-delta frame', () => {
    const event: StreamEvent = {
      type: 'stream:text-delta',
      content: 'Hello',
      accumulated: 'Hello',
    };

    expect(streamEventToFrame('run-1', event)).toEqual({
      type: 'stream:text-delta',
      runId: 'run-1',
      content: 'Hello',
      accumulated: 'Hello',
    });
  });

  it('maps a stream:tool-call-start event to a tool-call-start frame', () => {
    const event: StreamEvent = {
      type: 'stream:tool-call-start',
      toolName: 'search',
      blockId: 'block-1',
    };

    expect(streamEventToFrame('run-2', event)).toEqual({
      type: 'stream:tool-call-start',
      runId: 'run-2',
      toolName: 'search',
      blockId: 'block-1',
    });
  });

  it('maps a stream:tool-call-delta event to a tool-call-delta frame, renaming partialArguments to partialArgs', () => {
    const event: StreamEvent = {
      type: 'stream:tool-call-delta',
      toolName: 'search',
      blockId: 'block-1',
      partialArguments: '{"query":"a',
    };

    expect(streamEventToFrame('run-3', event)).toEqual({
      type: 'stream:tool-call-delta',
      runId: 'run-3',
      toolName: 'search',
      blockId: 'block-1',
      partialArgs: '{"query":"a',
    });
  });

  it('maps a stream:tool-call-complete event to a tool-call-complete frame', () => {
    const event: StreamEvent = {
      type: 'stream:tool-call-complete',
      toolName: 'search',
      blockId: 'block-1',
      arguments: { query: 'agent bureau' },
    };

    expect(streamEventToFrame('run-4', event)).toEqual({
      type: 'stream:tool-call-complete',
      runId: 'run-4',
      toolName: 'search',
      blockId: 'block-1',
      arguments: { query: 'agent bureau' },
    });
  });

  it('maps a stream:complete event to a complete frame', () => {
    const state = {
      blocks: [],
      activeBlock: undefined,
      textContent: 'done',
      toolCalls: [],
      complete: true,
    };
    const event: StreamEvent = { type: 'stream:complete', state };

    expect(streamEventToFrame('run-5', event)).toEqual({
      type: 'stream:complete',
      runId: 'run-5',
      state,
    });
  });

  it('maps a stream:error event carrying an Error to an error frame with the message', () => {
    const event: StreamEvent = { type: 'stream:error', error: new Error('provider timed out') };

    expect(streamEventToFrame('run-6', event)).toEqual({
      type: 'stream:error',
      runId: 'run-6',
      error: 'provider timed out',
    });
  });

  it('maps a stream:error event carrying a non-Error value by stringifying it', () => {
    const event: StreamEvent = { type: 'stream:error', error: 'raw string failure' };

    expect(streamEventToFrame('run-7', event)).toEqual({
      type: 'stream:error',
      runId: 'run-7',
      error: 'raw string failure',
    });
  });

  it('returns undefined for internal pipeline events with no client-facing frame (block-start/delta/complete, usage)', () => {
    const internalEvents: StreamEvent[] = [
      {
        type: 'stream:block-start',
        block: { id: 'b1', type: 'text', index: 0, content: '', complete: false },
      },
      {
        type: 'stream:block-delta',
        block: { id: 'b1', type: 'text', index: 0, content: 'a', complete: false },
        delta: 'a',
      },
      {
        type: 'stream:block-complete',
        block: { id: 'b1', type: 'text', index: 0, content: 'a', complete: true },
      },
      { type: 'stream:usage', usage: { prompt: 1, completion: 1, total: 2 } },
    ];

    for (const event of internalEvents) {
      expect(streamEventToFrame('run-8', event)).toBeUndefined();
    }
  });
});
