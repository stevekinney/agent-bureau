import type { StreamBlock, StreamState } from '../../streaming/types';

/** Tracks usage and block state for stream normalizers. */
export type NormalizerState = {
  blocks: StreamBlock[];
  hasUsageData: boolean;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
};

/** Find a block by ID in the blocks array. */
export function findBlock(blocks: StreamBlock[], id: string): StreamBlock | undefined {
  return blocks.find((b) => b.id === id);
}

/** Build a StreamState snapshot from the current normalizer state. */
export function buildState(state: NormalizerState): StreamState {
  const { blocks, hasUsageData, promptTokens, completionTokens } = state;
  return {
    blocks: [...blocks],
    activeBlock: [...blocks].reverse().find((b) => !b.complete),
    textContent: blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.content)
      .join(''),
    toolCalls: blocks.filter((b) => b.type === 'tool-call'),
    complete: false,
    usage: hasUsageData
      ? {
          prompt: promptTokens ?? 0,
          completion: completionTokens ?? 0,
          total: (promptTokens ?? 0) + (completionTokens ?? 0),
        }
      : undefined,
  };
}
