import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';

import { createChunkedTask } from '../../src/scheduler/create-chunked-task';
import { createScheduler } from '../../src/scheduler/create-scheduler';
import { createMockGenerate } from '../../src/test/index';
import type { GenerateResponse } from '../../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function createTestScheduler() {
  return createScheduler({
    generate: createMockGenerate([textResponse('default')]),
    toolbox: createTestToolbox([]),
    idleDelay: 1,
  });
}

describe('createChunkedTask', () => {
  it('processes all chunks sequentially until done', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    const chunkLog: number[] = [];

    const submitChunked = createChunkedTask<{ count: number }>({
      name: 'test-chunks',
      initialState: { count: 0 },
      processChunk: async (state) => {
        chunkLog.push(state.count);
        const nextCount = state.count + 1;
        return {
          state: { count: nextCount },
          done: nextCount >= 3,
        };
      },
    });

    const finalState = await submitChunked(scheduler);

    expect(finalState.count).toBe(3);
    expect(chunkLog).toEqual([0, 1, 2]);

    await scheduler.stop();
  });

  it('threads state correctly between chunks', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    const submitChunked = createChunkedTask<{ items: string[] }>({
      name: 'state-threading',
      initialState: { items: [] },
      processChunk: async (state) => {
        const newItems = [...state.items, `item-${state.items.length}`];
        return {
          state: { items: newItems },
          done: newItems.length >= 3,
        };
      },
    });

    const finalState = await submitChunked(scheduler);

    expect(finalState.items).toEqual(['item-0', 'item-1', 'item-2']);

    await scheduler.stop();
  });

  it('calls onComplete with the final state', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    let completedState: { count: number } | undefined;

    const submitChunked = createChunkedTask<{ count: number }>({
      name: 'on-complete',
      initialState: { count: 0 },
      processChunk: async (state) => ({
        state: { count: state.count + 1 },
        done: state.count + 1 >= 2,
      }),
      onComplete: (state) => {
        completedState = state;
      },
    });

    await submitChunked(scheduler);

    expect(completedState).toEqual({ count: 2 });

    await scheduler.stop();
  });

  it('calls onError and rejects when processChunk throws', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    let errorState: { count: number } | undefined;
    let errorValue: unknown;

    const submitChunked = createChunkedTask<{ count: number }>({
      name: 'on-error',
      initialState: { count: 0 },
      processChunk: async (state) => {
        if (state.count === 1) {
          throw new Error('chunk-failed');
        }
        return {
          state: { count: state.count + 1 },
          done: false,
        };
      },
      onError: (error, state) => {
        errorValue = error;
        errorState = state;
      },
    });

    await expect(submitChunked(scheduler)).rejects.toThrow('chunk-failed');

    expect(errorState).toEqual({ count: 1 });
    expect(errorValue).toBeInstanceOf(Error);

    await scheduler.stop();
  });

  it('resolves with the final state', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    const submitChunked = createChunkedTask<{ value: string }>({
      name: 'resolve-state',
      initialState: { value: 'start' },
      processChunk: async () => ({
        state: { value: 'end' },
        done: true,
      }),
    });

    const result = await submitChunked(scheduler);
    expect(result).toEqual({ value: 'end' });

    await scheduler.stop();
  });

  it('handles single-chunk tasks', async () => {
    const scheduler = createTestScheduler();
    scheduler.start();

    const submitChunked = createChunkedTask<{ processed: boolean }>({
      name: 'single-chunk',
      initialState: { processed: false },
      processChunk: async () => ({
        state: { processed: true },
        done: true,
      }),
    });

    const result = await submitChunked(scheduler);
    expect(result.processed).toBe(true);

    await scheduler.stop();
  });
});
