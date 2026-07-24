import type { StreamEvent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { parseClientFrame, streamEventToFrame } from './protocol';

describe('parseClientFrame', () => {
  it('parses a subscribe frame', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'subscribe', runId: 'run-1' }));
    expect(frame).toEqual({ type: 'subscribe', runId: 'run-1' });
  });

  it('parses an unsubscribe frame', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'unsubscribe', runId: 'run-1' }));
    expect(frame).toEqual({ type: 'unsubscribe', runId: 'run-1' });
  });

  it('parses a ping frame', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'ping' }));
    expect(frame).toEqual({ type: 'ping' });
  });

  it('returns error for invalid JSON', () => {
    const frame = parseClientFrame('not json');
    expect(frame.type).toBe('error');
    if (frame.type === 'error') {
      expect(frame.code).toBe('PARSE_ERROR');
    }
  });

  it('returns error for missing type field', () => {
    const frame = parseClientFrame(JSON.stringify({ runId: 'run-1' }));
    expect(frame.type).toBe('error');
    if (frame.type === 'error') {
      expect(frame.code).toBe('INVALID_FRAME');
    }
  });

  it('returns error for unknown type', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'unknown' }));
    expect(frame.type).toBe('error');
    if (frame.type === 'error') {
      expect(frame.code).toBe('UNKNOWN_TYPE');
    }
  });

  it('returns error for subscribe without runId', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'subscribe' }));
    expect(frame.type).toBe('error');
  });

  it('returns error for unsubscribe without runId', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'unsubscribe' }));
    expect(frame.type).toBe('error');
  });

  it('handles Buffer input', () => {
    const frame = parseClientFrame(Buffer.from(JSON.stringify({ type: 'ping' })));
    expect(frame).toEqual({ type: 'ping' });
  });

  it('returns INVALID_FRAME (not PARSE_ERROR) for a JSON null payload', () => {
    const frame = parseClientFrame('null');
    expect(frame.type).toBe('error');
    if (frame.type === 'error') {
      expect(frame.code).toBe('INVALID_FRAME');
    }
  });

  it('returns INVALID_FRAME for a JSON array payload', () => {
    const frame = parseClientFrame('[1,2,3]');
    expect(frame.type).toBe('error');
    if (frame.type === 'error') {
      expect(frame.code).toBe('INVALID_FRAME');
    }
  });

  it('returns INVALID_FRAME for a JSON scalar payload', () => {
    const frame = parseClientFrame('42');
    expect(frame.type).toBe('error');
    if (frame.type === 'error') {
      expect(frame.code).toBe('INVALID_FRAME');
    }
  });

  it('drops a negative "since" on subscribe instead of accepting it', () => {
    const frame = parseClientFrame(
      JSON.stringify({ type: 'subscribe', runId: 'run-1', since: -5 }),
    );
    expect(frame).toEqual({ type: 'subscribe', runId: 'run-1', since: undefined });
  });

  it('drops a fractional "since" on subscribe instead of accepting it', () => {
    const frame = parseClientFrame(
      JSON.stringify({ type: 'subscribe', runId: 'run-1', since: 1.5 }),
    );
    expect(frame).toEqual({ type: 'subscribe', runId: 'run-1', since: undefined });
  });

  it('accepts a safe non-negative integer "since" on subscribe', () => {
    const frame = parseClientFrame(JSON.stringify({ type: 'subscribe', runId: 'run-1', since: 0 }));
    expect(frame).toEqual({ type: 'subscribe', runId: 'run-1', since: 0 });
  });
});

describe('streamEventToFrame', () => {
  it('converts stream:text-delta to a ServerFrame', () => {
    const event: StreamEvent = {
      type: 'stream:text-delta',
      content: 'Hello',
      accumulated: 'Hello',
    };

    const frame = streamEventToFrame('run-1', event);
    expect(frame).toBeDefined();
    expect(frame?.type).toBe('stream:text-delta');
    if (frame?.type === 'stream:text-delta') {
      expect(frame.runId).toBe('run-1');
      expect(frame.content).toBe('Hello');
      expect(frame.accumulated).toBe('Hello');
    }
  });

  it('converts stream:tool-call-start to a ServerFrame', () => {
    const event: StreamEvent = {
      type: 'stream:tool-call-start',
      toolName: 'get_weather',
      blockId: 'block-1',
    };

    const frame = streamEventToFrame('run-2', event);
    expect(frame).toBeDefined();
    expect(frame?.type).toBe('stream:tool-call-start');
    if (frame?.type === 'stream:tool-call-start') {
      expect(frame.runId).toBe('run-2');
      expect(frame.toolName).toBe('get_weather');
    }
  });

  it('converts stream:tool-call-delta to a ServerFrame', () => {
    const event: StreamEvent = {
      type: 'stream:tool-call-delta',
      toolName: 'search',
      blockId: 'block-1',
      partialArguments: '{"query":',
    };

    const frame = streamEventToFrame('run-3', event);
    expect(frame).toBeDefined();
    if (frame?.type === 'stream:tool-call-delta') {
      expect(frame.toolName).toBe('search');
      expect(frame.partialArgs).toBe('{"query":');
    }
  });

  it('converts stream:tool-call-complete to a ServerFrame', () => {
    const event: StreamEvent = {
      type: 'stream:tool-call-complete',
      toolName: 'search',
      blockId: 'block-2',
      arguments: { query: 'test' },
    };

    const frame = streamEventToFrame('run-4', event);
    expect(frame).toBeDefined();
    if (frame?.type === 'stream:tool-call-complete') {
      expect(frame.toolName).toBe('search');
      expect(frame.arguments).toEqual({ query: 'test' });
    }
  });

  it('converts stream:complete to a ServerFrame with state', () => {
    const event: StreamEvent = {
      type: 'stream:complete',
      state: {
        blocks: [],
        activeBlock: undefined,
        textContent: 'Hello',
        toolCalls: [],
        complete: true,
      },
    };

    const frame = streamEventToFrame('run-5', event);
    expect(frame).toBeDefined();
    if (frame?.type === 'stream:complete') {
      expect(frame.runId).toBe('run-5');
      expect(frame.state).toBeDefined();
    }
  });

  it('converts stream:error to a ServerFrame with string error', () => {
    const event: StreamEvent = {
      type: 'stream:error',
      error: new Error('Connection lost'),
    };

    const frame = streamEventToFrame('run-6', event);
    expect(frame).toBeDefined();
    if (frame?.type === 'stream:error') {
      expect(frame.runId).toBe('run-6');
      expect(frame.error).toBe('Connection lost');
    }
  });

  it('returns undefined for internal-only events', () => {
    const blockStart: StreamEvent = {
      type: 'stream:block-start',
      block: {
        id: 'b1',
        type: 'text',
        index: 0,
        content: '',
        complete: false,
      },
    };

    expect(streamEventToFrame('run-7', blockStart)).toBeUndefined();
  });

  it('converts non-Error stream:error to string', () => {
    const event: StreamEvent = {
      type: 'stream:error',
      error: 'simple string error',
    };

    const frame = streamEventToFrame('run-8', event);
    if (frame?.type === 'stream:error') {
      expect(frame.error).toBe('simple string error');
    }
  });
});
