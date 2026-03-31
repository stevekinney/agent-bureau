import type { StreamEvent } from './types';

/** Options for creating a backpressure buffer. */
export type BackpressureBufferOptions = {
  /** Maximum number of events to buffer before coalescing or dropping. Default: 100. */
  maxBufferSize?: number;
  /** Whether to coalesce consecutive text deltas when the buffer overflows. Default: true. */
  coalesceDeltas?: boolean;
  /** Called when events are dropped or coalesced due to buffer overflow. */
  onOverflow?: (droppedCount: number) => void;
  /** Called to emit an event to the consumer. */
  onEmit: (event: StreamEvent) => void;
};

/** A backpressure buffer that queues, coalesces, and drops stream events. */
export type BackpressureBuffer = {
  /** Push an event into the buffer. If not paused, emits immediately. */
  push(event: StreamEvent): void;
  /** Pause emission — events accumulate in the buffer. */
  pause(): void;
  /** Resume emission — flushes all buffered events. */
  resume(): void;
  /** Flush remaining events and mark the buffer as disposed. */
  dispose(): void;
};

/**
 * Creates a backpressure buffer for stream events.
 *
 * When the consumer is keeping up (not paused), events pass through immediately.
 * When paused, events accumulate in a buffer. If the buffer exceeds `maxBufferSize`,
 * consecutive text-delta events are coalesced into a single event (when enabled),
 * and text-delta events are dropped as a last resort. Non-text events (tool calls,
 * completion, errors) are always preserved.
 */
export function createBackpressureBuffer(options: BackpressureBufferOptions): BackpressureBuffer {
  const { maxBufferSize = 100, coalesceDeltas = true, onOverflow, onEmit } = options;

  let buffer: StreamEvent[] = [];
  let paused = false;
  let disposed = false;

  function isTextDelta(
    event: StreamEvent,
  ): event is Extract<StreamEvent, { type: 'stream:text-delta' }> {
    return event.type === 'stream:text-delta';
  }

  function isDroppable(event: StreamEvent): boolean {
    return event.type === 'stream:text-delta' || event.type === 'stream:block-delta';
  }

  function isBlockDelta(
    event: StreamEvent,
  ): event is Extract<StreamEvent, { type: 'stream:block-delta' }> {
    return event.type === 'stream:block-delta';
  }

  /**
   * Coalesce runs of text-delta and block-delta events in the buffer.
   *
   * Normalizers emit a stream:block-delta immediately after each
   * stream:text-delta, so we treat both types as part of a coalesceble
   * run. Within a run, text-deltas are merged into one and block-deltas
   * are merged into one (keeping the last block snapshot).
   */
  function coalesceBuffer(): number {
    if (!coalesceDeltas) return 0;

    const coalesced: StreamEvent[] = [];
    let droppedCount = 0;

    for (let i = 0; i < buffer.length; i++) {
      const event = buffer[i]!;

      if (isTextDelta(event) || isBlockDelta(event)) {
        // Collect a run of text-delta and block-delta events
        let combinedContent = isTextDelta(event) ? event.content : '';
        let lastAccumulated = isTextDelta(event) ? event.accumulated : '';
        let lastBlockDelta: Extract<StreamEvent, { type: 'stream:block-delta' }> | undefined =
          isBlockDelta(event) ? event : undefined;
        let hasTextDelta = isTextDelta(event);
        let combinedBlockDeltaContent = isBlockDelta(event) ? event.delta : '';
        let j = i + 1;

        while (j < buffer.length && (isTextDelta(buffer[j]!) || isBlockDelta(buffer[j]!))) {
          const next = buffer[j]!;
          if (isTextDelta(next)) {
            combinedContent += next.content;
            lastAccumulated = next.accumulated;
            // Only count as dropped if we already had a text-delta (the first one produces output)
            if (hasTextDelta) droppedCount++;
            hasTextDelta = true;
          } else if (isBlockDelta(next)) {
            combinedBlockDeltaContent += next.delta;
            // Only count as dropped if we already had a block-delta (the first one produces output)
            if (lastBlockDelta) droppedCount++;
            lastBlockDelta = next;
          }
          j++;
        }

        if (hasTextDelta) {
          coalesced.push({
            type: 'stream:text-delta',
            content: combinedContent,
            accumulated: lastAccumulated,
          });
        }

        if (lastBlockDelta) {
          coalesced.push({
            type: 'stream:block-delta',
            block: lastBlockDelta.block,
            delta: combinedBlockDeltaContent,
          });
        }

        // Skip the events we just merged
        i = j - 1;
      } else {
        coalesced.push(event);
      }
    }

    buffer = coalesced;
    return droppedCount;
  }

  /** Drop text deltas when buffer is still too large after coalescing. */
  function dropExcess(): number {
    if (buffer.length <= maxBufferSize) return 0;

    const kept: StreamEvent[] = [];
    let droppedCount = 0;

    for (const event of buffer) {
      if (kept.length >= maxBufferSize && isDroppable(event)) {
        droppedCount++;
        continue;
      }
      kept.push(event);
    }

    buffer = kept;
    return droppedCount;
  }

  function flush(): void {
    const toEmit = [...buffer];
    buffer = [];
    for (const event of toEmit) {
      onEmit(event);
    }
  }

  function push(event: StreamEvent): void {
    if (disposed) return;

    if (!paused) {
      onEmit(event);
      return;
    }

    buffer.push(event);

    if (buffer.length > maxBufferSize) {
      const coalesceDrops = coalesceBuffer();
      const excessDrops = dropExcess();
      const totalDrops = coalesceDrops + excessDrops;
      if (totalDrops > 0) {
        onOverflow?.(totalDrops);
      }
    }
  }

  function pause(): void {
    paused = true;
  }

  function resume(): void {
    paused = false;
    flush();
  }

  function dispose(): void {
    if (!disposed) {
      flush();
      disposed = true;
    }
  }

  return { push, pause, resume, dispose };
}
