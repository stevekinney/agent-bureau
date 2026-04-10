import { describe, expect, it } from 'bun:test';

import { INITIAL_TOOL_ACTIVITY_STATE, reduceToolActivity } from './tool-activity';

describe('reduceToolActivity', () => {
  it('updates the matching activity entry when tool-call deltas interleave', () => {
    let state = INITIAL_TOOL_ACTIVITY_STATE;

    state = reduceToolActivity(state, {
      type: 'start',
      blockId: 'block-a',
      message: 'Calling search',
    });
    state = reduceToolActivity(state, {
      type: 'start',
      blockId: 'block-b',
      message: 'Calling fetch',
    });
    state = reduceToolActivity(state, {
      type: 'update',
      blockId: 'block-a',
      message: 'search: {"query":"agent"',
    });
    state = reduceToolActivity(state, {
      type: 'update',
      blockId: 'block-b',
      message: 'fetch: {"url":"https://example.com"}',
    });

    expect(state.entries).toEqual([
      'search: {"query":"agent"',
      'fetch: {"url":"https://example.com"}',
    ]);
  });

  it('marks completed tool calls in place and clears their active block mapping', () => {
    let state = INITIAL_TOOL_ACTIVITY_STATE;

    state = reduceToolActivity(state, {
      type: 'start',
      blockId: 'block-a',
      message: 'Calling search',
    });
    state = reduceToolActivity(state, {
      type: 'complete',
      blockId: 'block-a',
      message: 'search completed {"query":"agent"}',
    });
    state = reduceToolActivity(state, {
      type: 'update',
      blockId: 'block-b',
      message: 'fetch: {"url":"https://example.com"}',
    });

    expect(state.entries).toEqual([
      'search completed {"query":"agent"}',
      'fetch: {"url":"https://example.com"}',
    ]);
    expect(state.blockIndices['block-a']).toBeUndefined();
    expect(state.blockIndices['block-b']).toBe(1);
  });

  it('appends ad hoc messages and resets cleanly', () => {
    let state = INITIAL_TOOL_ACTIVITY_STATE;

    state = reduceToolActivity(state, {
      type: 'append',
      message: 'Streaming error: disconnected',
    });

    expect(state.entries).toEqual(['Streaming error: disconnected']);

    state = reduceToolActivity(state, { type: 'reset' });

    expect(state).toEqual(INITIAL_TOOL_ACTIVITY_STATE);
  });
});
