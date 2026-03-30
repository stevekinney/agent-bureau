import { describe, expect, it } from 'bun:test';

import { createStreamStateMachine } from './stream-state-machine';
import type { StreamCommand } from './types';

describe('createStreamStateMachine', () => {
  it('starts with empty initial state', () => {
    const machine = createStreamStateMachine();
    const state = machine.getState();

    expect(state.blocks).toEqual([]);
    expect(state.activeBlock).toBeUndefined();
    expect(state.textContent).toBe('');
    expect(state.toolCalls).toEqual([]);
    expect(state.complete).toBe(false);
    expect(state.usage).toBeUndefined();
  });

  it('creates a block on block-start', () => {
    const machine = createStreamStateMachine();
    const state = machine.process({
      type: 'block-start',
      id: 'block-1',
      blockType: 'text',
    });

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.id).toBe('block-1');
    expect(state.blocks[0]?.type).toBe('text');
    expect(state.blocks[0]?.index).toBe(0);
    expect(state.blocks[0]?.content).toBe('');
    expect(state.blocks[0]?.complete).toBe(false);
    expect(state.activeBlock).toBeDefined();
    expect(state.activeBlock?.id).toBe('block-1');
  });

  it('updates active block content on block-delta', () => {
    const machine = createStreamStateMachine();
    machine.process({ type: 'block-start', id: 'block-1', blockType: 'text' });
    const state = machine.process({ type: 'block-delta', id: 'block-1', delta: 'Hello' });

    expect(state.blocks[0]?.content).toBe('Hello');
    expect(state.activeBlock?.content).toBe('Hello');
  });

  it('appends deltas to existing content', () => {
    const machine = createStreamStateMachine();
    machine.process({ type: 'block-start', id: 'block-1', blockType: 'text' });
    machine.process({ type: 'block-delta', id: 'block-1', delta: 'Hello' });
    const state = machine.process({ type: 'block-delta', id: 'block-1', delta: ', world!' });

    expect(state.blocks[0]?.content).toBe('Hello, world!');
  });

  it('marks block as complete on block-complete', () => {
    const machine = createStreamStateMachine();
    machine.process({ type: 'block-start', id: 'block-1', blockType: 'text' });
    machine.process({ type: 'block-delta', id: 'block-1', delta: 'Done' });
    const state = machine.process({ type: 'block-complete', id: 'block-1' });

    expect(state.blocks[0]?.complete).toBe(true);
    expect(state.activeBlock).toBeUndefined();
  });

  it('aggregates textContent from all text blocks', () => {
    const machine = createStreamStateMachine();

    machine.process({ type: 'block-start', id: 'block-1', blockType: 'text' });
    machine.process({ type: 'block-delta', id: 'block-1', delta: 'First. ' });
    machine.process({ type: 'block-complete', id: 'block-1' });

    machine.process({ type: 'block-start', id: 'block-2', blockType: 'text' });
    const state = machine.process({ type: 'block-delta', id: 'block-2', delta: 'Second.' });

    expect(state.textContent).toBe('First. Second.');
  });

  it('filters toolCalls to only tool-call blocks', () => {
    const machine = createStreamStateMachine();

    machine.process({ type: 'block-start', id: 'text-1', blockType: 'text' });
    machine.process({ type: 'block-delta', id: 'text-1', delta: 'Hello' });
    machine.process({ type: 'block-complete', id: 'text-1' });

    machine.process({
      type: 'block-start',
      id: 'tool-1',
      blockType: 'tool-call',
      toolName: 'get_weather',
    });

    const state = machine.process({
      type: 'block-delta',
      id: 'tool-1',
      delta: '{"location":"Denver"}',
    });

    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]?.id).toBe('tool-1');
    expect(state.toolCalls[0]?.toolName).toBe('get_weather');
  });

  it('stores toolName and accumulates partialArguments for tool-call blocks', () => {
    const machine = createStreamStateMachine();

    machine.process({
      type: 'block-start',
      id: 'tool-1',
      blockType: 'tool-call',
      toolName: 'search',
    });
    machine.process({ type: 'block-delta', id: 'tool-1', delta: '{"query":' });
    const state = machine.process({ type: 'block-delta', id: 'tool-1', delta: '"test"}' });

    expect(state.toolCalls[0]?.toolName).toBe('search');
    expect(state.toolCalls[0]?.partialArguments).toBe('{"query":"test"}');
  });

  it('sets complete flag when stream completes', () => {
    const machine = createStreamStateMachine();
    const state = machine.process({ type: 'complete' });

    expect(state.complete).toBe(true);
  });

  it('tracks token usage', () => {
    const machine = createStreamStateMachine();
    const usage = { prompt: 100, completion: 50, total: 150 };
    const state = machine.process({ type: 'set-usage', usage });

    expect(state.usage).toEqual(usage);
  });

  it('handles interleaved text and tool-call blocks', () => {
    const machine = createStreamStateMachine();

    // Text block
    machine.process({ type: 'block-start', id: 'text-1', blockType: 'text' });
    machine.process({ type: 'block-delta', id: 'text-1', delta: 'Looking up weather... ' });
    machine.process({ type: 'block-complete', id: 'text-1' });

    // Tool call block
    machine.process({
      type: 'block-start',
      id: 'tool-1',
      blockType: 'tool-call',
      toolName: 'get_weather',
    });
    machine.process({ type: 'block-delta', id: 'tool-1', delta: '{"city":"NYC"}' });
    machine.process({ type: 'block-complete', id: 'tool-1' });

    // Another text block
    machine.process({ type: 'block-start', id: 'text-2', blockType: 'text' });
    machine.process({ type: 'block-delta', id: 'text-2', delta: 'Here are the results.' });

    const state = machine.process({ type: 'complete' });

    expect(state.blocks).toHaveLength(3);
    expect(state.textContent).toBe('Looking up weather... Here are the results.');
    expect(state.toolCalls).toHaveLength(1);
    expect(state.complete).toBe(true);
  });

  it('handles thinking blocks separately from text', () => {
    const machine = createStreamStateMachine();

    machine.process({ type: 'block-start', id: 'think-1', blockType: 'thinking' });
    machine.process({ type: 'block-delta', id: 'think-1', delta: 'Let me think...' });
    machine.process({ type: 'block-complete', id: 'think-1' });

    machine.process({ type: 'block-start', id: 'text-1', blockType: 'text' });
    machine.process({ type: 'block-delta', id: 'text-1', delta: 'The answer is 42.' });

    const state = machine.getState();

    // Thinking blocks should not be included in textContent
    expect(state.textContent).toBe('The answer is 42.');
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]?.type).toBe('thinking');
    expect(state.blocks[1]?.type).toBe('text');
  });

  it('resets to initial state', () => {
    const machine = createStreamStateMachine();

    machine.process({ type: 'block-start', id: 'block-1', blockType: 'text' });
    machine.process({ type: 'block-delta', id: 'block-1', delta: 'Hello' });
    machine.process({
      type: 'set-usage',
      usage: { prompt: 10, completion: 5, total: 15 },
    });

    machine.reset();
    const state = machine.getState();

    expect(state.blocks).toEqual([]);
    expect(state.activeBlock).toBeUndefined();
    expect(state.textContent).toBe('');
    expect(state.toolCalls).toEqual([]);
    expect(state.complete).toBe(false);
    expect(state.usage).toBeUndefined();
  });

  it('ignores block-delta for unknown block id', () => {
    const machine = createStreamStateMachine();
    machine.process({ type: 'block-start', id: 'block-1', blockType: 'text' });

    // Delta for non-existent block should not throw
    const state = machine.process({ type: 'block-delta', id: 'unknown', delta: 'data' });
    expect(state.blocks[0]?.content).toBe('');
  });

  it('ignores block-complete for unknown block id', () => {
    const machine = createStreamStateMachine();
    // Should not throw
    const state = machine.process({ type: 'block-complete', id: 'unknown' });
    expect(state.blocks).toEqual([]);
  });

  it('assigns sequential indices to blocks', () => {
    const machine = createStreamStateMachine();
    machine.process({ type: 'block-start', id: 'a', blockType: 'text' });
    machine.process({ type: 'block-start', id: 'b', blockType: 'tool-call', toolName: 'foo' });
    const state = machine.process({ type: 'block-start', id: 'c', blockType: 'thinking' });

    expect(state.blocks[0]?.index).toBe(0);
    expect(state.blocks[1]?.index).toBe(1);
    expect(state.blocks[2]?.index).toBe(2);
  });

  it('updates active block to the most recently started incomplete block', () => {
    const machine = createStreamStateMachine();

    machine.process({ type: 'block-start', id: 'a', blockType: 'text' });
    machine.process({ type: 'block-start', id: 'b', blockType: 'text' });

    // Active block should be the most recently started one
    expect(machine.getState().activeBlock?.id).toBe('b');

    // Complete block b — active should revert to a (still incomplete)
    machine.process({ type: 'block-complete', id: 'b' });
    expect(machine.getState().activeBlock?.id).toBe('a');

    // Complete block a — no active block left
    machine.process({ type: 'block-complete', id: 'a' });
    expect(machine.getState().activeBlock).toBeUndefined();
  });

  it('processes a series of commands in order', () => {
    const machine = createStreamStateMachine();
    const commands: StreamCommand[] = [
      { type: 'block-start', id: 'b1', blockType: 'text' },
      { type: 'block-delta', id: 'b1', delta: 'A' },
      { type: 'block-delta', id: 'b1', delta: 'B' },
      { type: 'block-complete', id: 'b1' },
      { type: 'set-usage', usage: { prompt: 20, completion: 10, total: 30 } },
      { type: 'complete' },
    ];

    let state = machine.getState();
    for (const command of commands) {
      state = machine.process(command);
    }

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.content).toBe('AB');
    expect(state.blocks[0]?.complete).toBe(true);
    expect(state.textContent).toBe('AB');
    expect(state.complete).toBe(true);
    expect(state.usage).toEqual({ prompt: 20, completion: 10, total: 30 });
  });
});
