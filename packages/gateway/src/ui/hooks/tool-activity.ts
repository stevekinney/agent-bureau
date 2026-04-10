export type ToolActivityState = {
  readonly entries: readonly string[];
  readonly blockIndices: Readonly<Record<string, number>>;
};

export type ToolActivityAction =
  | { type: 'append'; message: string }
  | { type: 'reset' }
  | { type: 'start'; blockId: string; message: string }
  | { type: 'update'; blockId: string; message: string }
  | { type: 'complete'; blockId: string; message: string };

export const INITIAL_TOOL_ACTIVITY_STATE: ToolActivityState = {
  entries: [],
  blockIndices: {},
};

function withoutBlockIndex(
  blockIndices: ToolActivityState['blockIndices'],
  blockId: string,
): ToolActivityState['blockIndices'] {
  if (!(blockId in blockIndices)) {
    return blockIndices;
  }

  const { [blockId]: _removed, ...remaining } = blockIndices;
  return remaining;
}

function upsertBlockEntry(
  state: ToolActivityState,
  blockId: string,
  message: string,
  completed = false,
): ToolActivityState {
  const existingIndex = state.blockIndices[blockId];
  const blockIndices = completed
    ? withoutBlockIndex(state.blockIndices, blockId)
    : state.blockIndices;

  if (existingIndex !== undefined) {
    const entries = [...state.entries];
    entries[existingIndex] = message;
    return {
      entries,
      blockIndices,
    };
  }

  const entries = [...state.entries, message];
  return {
    entries,
    blockIndices: completed ? blockIndices : { ...blockIndices, [blockId]: entries.length - 1 },
  };
}

/**
 * Keeps streamed tool activity aligned with the originating `blockId`, so
 * interleaved tool calls update the correct UI entry.
 */
export function reduceToolActivity(
  state: ToolActivityState,
  action: ToolActivityAction,
): ToolActivityState {
  switch (action.type) {
    case 'append':
      return {
        ...state,
        entries: [...state.entries, action.message],
      };
    case 'reset':
      return INITIAL_TOOL_ACTIVITY_STATE;
    case 'start':
    case 'update':
      return upsertBlockEntry(state, action.blockId, action.message);
    case 'complete':
      return upsertBlockEntry(state, action.blockId, action.message, true);
  }
}
