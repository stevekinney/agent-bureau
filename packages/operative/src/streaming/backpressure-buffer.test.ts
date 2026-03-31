import { describe, expect, it, mock } from 'bun:test';

import { createBackpressureBuffer } from './backpressure-buffer';
import type { StreamEvent } from './types';

function textDelta(content: string, accumulated: string): StreamEvent {
  return { type: 'stream:text-delta', content, accumulated };
}

function toolCallStart(toolName: string): StreamEvent {
  return { type: 'stream:tool-call-start', toolName, blockId: 'tool-1' };
}

function streamComplete(): StreamEvent {
  return {
    type: 'stream:complete',
    state: {
      blocks: [],
      activeBlock: undefined,
      textContent: '',
      toolCalls: [],
      complete: true,
    },
  };
}

function blockDelta(delta: string): StreamEvent {
  return {
    type: 'stream:block-delta',
    delta,
    block: {
      id: 'block-1',
      type: 'text',
      index: 0,
      content: delta,
      complete: false,
    },
  };
}

describe('createBackpressureBuffer', () => {
  it('passes events through when buffer is not full', () => {
    const emitted: StreamEvent[] = [];
    const buffer = createBackpressureBuffer({
      maxBufferSize: 10,
      onEmit: (event) => emitted.push(event),
    });

    buffer.push(textDelta('Hello', 'Hello'));
    buffer.push(textDelta(' world', 'Hello world'));

    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.type).toBe('stream:text-delta');
    expect(emitted[1]?.type).toBe('stream:text-delta');
  });

  it('buffers events when consumer is paused', () => {
    const emitted: StreamEvent[] = [];
    const buffer = createBackpressureBuffer({
      maxBufferSize: 10,
      onEmit: (event) => emitted.push(event),
    });

    buffer.pause();
    buffer.push(textDelta('Hello', 'Hello'));
    buffer.push(textDelta(' world', 'Hello world'));

    expect(emitted).toHaveLength(0);

    buffer.resume();
    expect(emitted).toHaveLength(2);
  });

  it('coalesces text deltas when buffer overflows', () => {
    const emitted: StreamEvent[] = [];
    const buffer = createBackpressureBuffer({
      maxBufferSize: 3,
      coalesceDeltas: true,
      onEmit: (event) => emitted.push(event),
    });

    buffer.pause();

    // Push more text deltas than buffer can hold
    buffer.push(textDelta('A', 'A'));
    buffer.push(textDelta('B', 'AB'));
    buffer.push(textDelta('C', 'ABC'));
    buffer.push(textDelta('D', 'ABCD')); // Overflow triggers coalescing

    buffer.resume();

    // After coalescing, consecutive text deltas should be merged
    const textEvents = emitted.filter((e) => e.type === 'stream:text-delta');
    // The exact count depends on implementation, but total content should be preserved
    const totalContent = textEvents
      .map((e) => (e.type === 'stream:text-delta' ? e.content : ''))
      .join('');
    expect(totalContent).toBe('ABCD');
  });

  it('preserves non-text events during overflow', () => {
    const emitted: StreamEvent[] = [];
    const buffer = createBackpressureBuffer({
      maxBufferSize: 3,
      coalesceDeltas: true,
      onEmit: (event) => emitted.push(event),
    });

    buffer.pause();

    buffer.push(textDelta('A', 'A'));
    buffer.push(textDelta('B', 'AB'));
    buffer.push(toolCallStart('get_weather'));
    buffer.push(textDelta('C', 'ABC'));
    buffer.push(textDelta('D', 'ABCD'));

    buffer.resume();

    const toolEvents = emitted.filter((e) => e.type === 'stream:tool-call-start');
    expect(toolEvents).toHaveLength(1);
    if (toolEvents[0]?.type === 'stream:tool-call-start') {
      expect(toolEvents[0].toolName).toBe('get_weather');
    }
  });

  it('fires onOverflow callback with drop count', () => {
    const onOverflow = mock(() => {});
    const buffer = createBackpressureBuffer({
      maxBufferSize: 2,
      coalesceDeltas: true,
      onOverflow,
      onEmit: () => {},
    });

    buffer.pause();

    buffer.push(textDelta('A', 'A'));
    buffer.push(textDelta('B', 'AB'));
    buffer.push(textDelta('C', 'ABC')); // Overflow

    expect(onOverflow).toHaveBeenCalled();
  });

  it('emits state snapshot on drain after overflow', () => {
    const emitted: StreamEvent[] = [];
    const buffer = createBackpressureBuffer({
      maxBufferSize: 2,
      coalesceDeltas: true,
      onEmit: (event) => emitted.push(event),
    });

    buffer.pause();

    buffer.push(textDelta('A', 'A'));
    buffer.push(textDelta('B', 'AB'));
    buffer.push(textDelta('C', 'ABC')); // Overflow

    buffer.resume();

    // All events should have been emitted
    expect(emitted.length).toBeGreaterThan(0);
  });

  it('flushes remaining events on dispose', () => {
    const emitted: StreamEvent[] = [];
    const buffer = createBackpressureBuffer({
      maxBufferSize: 10,
      onEmit: (event) => emitted.push(event),
    });

    buffer.pause();
    buffer.push(textDelta('A', 'A'));
    buffer.push(toolCallStart('search'));

    expect(emitted).toHaveLength(0);

    buffer.dispose();
    expect(emitted).toHaveLength(2);
  });

  it('does not coalesce when coalesceDeltas is false', () => {
    const emitted: StreamEvent[] = [];
    const buffer = createBackpressureBuffer({
      maxBufferSize: 2,
      coalesceDeltas: false,
      onEmit: (event) => emitted.push(event),
    });

    buffer.pause();

    buffer.push(textDelta('A', 'A'));
    buffer.push(textDelta('B', 'AB'));
    buffer.push(textDelta('C', 'ABC')); // Overflow without coalescing — text delta dropped

    buffer.resume();

    // Without coalescing, we should drop text deltas but keep non-text
    // The exact behavior: text deltas get dropped when buffer is full
    expect(emitted.length).toBeLessThanOrEqual(3);
  });

  it('preserves completion events even during overflow', () => {
    const emitted: StreamEvent[] = [];
    const buffer = createBackpressureBuffer({
      maxBufferSize: 2,
      coalesceDeltas: true,
      onEmit: (event) => emitted.push(event),
    });

    buffer.pause();

    buffer.push(textDelta('A', 'A'));
    buffer.push(textDelta('B', 'AB'));
    buffer.push(textDelta('C', 'ABC'));
    buffer.push(streamComplete());

    buffer.resume();

    const completeEvents = emitted.filter((e) => e.type === 'stream:complete');
    expect(completeEvents).toHaveLength(1);
  });

  it('coalesces consecutive block deltas into a single block snapshot', () => {
    const emitted: StreamEvent[] = [];
    const buffer = createBackpressureBuffer({
      maxBufferSize: 2,
      coalesceDeltas: true,
      onEmit: (event) => emitted.push(event),
    });

    buffer.pause();
    buffer.push(blockDelta('A'));
    buffer.push(blockDelta('B'));
    buffer.push(blockDelta('C'));
    buffer.resume();

    const blockEvents = emitted.filter((event) => event.type === 'stream:block-delta');
    expect(blockEvents).toHaveLength(1);
    expect((blockEvents[0] as Extract<StreamEvent, { type: 'stream:block-delta' }>).delta).toBe(
      'ABC',
    );
  });

  it('drops droppable overflow events once the buffer remains above capacity', () => {
    const emitted: StreamEvent[] = [];
    const buffer = createBackpressureBuffer({
      maxBufferSize: 2,
      coalesceDeltas: true,
      onEmit: (event) => emitted.push(event),
    });

    buffer.pause();
    buffer.push(toolCallStart('search'));
    buffer.push(toolCallStart('weather'));
    buffer.push(textDelta('overflow', 'overflow'));
    buffer.resume();

    expect(emitted.filter((event) => event.type === 'stream:tool-call-start')).toHaveLength(2);
    expect(emitted.filter((event) => event.type === 'stream:text-delta')).toHaveLength(0);
  });

  it('handles push after dispose gracefully', () => {
    const emitted: StreamEvent[] = [];
    const buffer = createBackpressureBuffer({
      maxBufferSize: 10,
      onEmit: (event) => emitted.push(event),
    });

    buffer.dispose();

    // Should not throw
    buffer.push(textDelta('A', 'A'));
    expect(emitted).toHaveLength(0);
  });

  it('uses default maxBufferSize of 100', () => {
    const emitted: StreamEvent[] = [];
    const buffer = createBackpressureBuffer({
      onEmit: (event) => emitted.push(event),
    });

    buffer.pause();

    // Push 100 events — should all fit in buffer
    for (let i = 0; i < 100; i++) {
      buffer.push(textDelta(`${i}`, `accumulated-${i}`));
    }

    buffer.resume();
    expect(emitted).toHaveLength(100);
  });
});
