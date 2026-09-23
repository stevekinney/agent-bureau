import { parseJSONValue } from './adapters/shared';
import type { MultiModalContent } from './multi-modal';
import type { JSONValue, ToolCall } from './types';

// ─── Multi-part streaming accumulation ──────────────────────────────────────

/**
 * Discriminated union representing the accumulated state of one content block
 * during a streaming response. Each variant maps to an Anthropic block type.
 */
export type BlockAccumulatorState =
  // A text block may also accumulate citation objects via citations_delta.
  | { type: 'text'; buffer: string; citations?: JSONValue[] }
  | { type: 'thinking'; buffer: string; signature: string }
  // redacted_thinking carries its encrypted payload in `data` (seeded at
  // content_block_start), not a streamed signature.
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; inputBuffer: string }
  | { type: 'server_tool_use'; id: string; name: string; inputBuffer: string }
  // Server-tool result blocks (web search, code execution) arrive with their
  // content in the content_block_start event rather than via deltas, so the
  // content is seeded at openBlock and carried through unchanged.
  | { type: 'web_search_tool_result'; tool_use_id: string; content: JSONValue }
  | {
      type:
        | 'code_execution_tool_result'
        | 'bash_code_execution_tool_result'
        | 'text_editor_code_execution_tool_result'
        | 'web_fetch_tool_result';
      tool_use_id: string;
      content: JSONValue;
    };

/**
 * An accumulator for a single content block within a streaming response.
 * Call the appropriate `append*` method as deltas arrive, then read `state`
 * once `content_block_stop` fires.
 */
export interface BlockAccumulator {
  /** Current accumulated state of this block. */
  readonly state: BlockAccumulatorState;
  /** Append a text_delta to a text or thinking block. */
  appendTextDelta(delta: string): void;
  /** Append a citations_delta entry to a text block (accumulates citation objects). */
  appendCitationsDelta(citation: JSONValue): void;
  /** Append a thinking_delta to a thinking block. */
  appendThinkingDelta(delta: string): void;
  /**
   * Append a signature_delta chunk to a thinking block's signature. Anthropic
   * may split the signature across multiple signature_delta events, so this
   * accumulates rather than replaces — the full signature must survive
   * byte-for-byte for extended-thinking replay.
   */
  appendSignatureDelta(delta: string): void;
  /** Append an input_json_delta to a tool_use or server_tool_use block. */
  appendInputJsonDelta(delta: string): void;
}

/**
 * One ordered piece of a finalized stream. Either a run of assistant content
 * blocks, or a single client tool call (which the conversation model represents
 * as its own `tool-call` role message). Emitting these in order preserves the
 * stream's true block order even when a client `tool_use` is interleaved between
 * content blocks (`[text, tool_use, text]`).
 */
export type StreamSegment =
  { kind: 'content'; content: MultiModalContent[] } | { kind: 'tool-call'; toolCall: ToolCall };

/**
 * The result of finalizing a streamed message: an ordered list of
 * {@link StreamSegment}s. The caller appends each segment in order — a `content`
 * segment as an assistant message, a `tool-call` segment as a `tool-call` role
 * message — which both keeps tool-call/tool-result pairing intact (the tool call
 * becomes a real message a later `tool-result` can reference) AND preserves the
 * original block order. {@link contentOf} / {@link toolCallsOf} are convenience
 * accessors when order across the content/tool boundary does not matter.
 */
export interface StreamFinalizeResult {
  segments: StreamSegment[];
}

/** All assistant-content blocks across a finalized stream, in order (ignoring tool-call interleaving). */
export function contentOf(result: StreamFinalizeResult): MultiModalContent[] {
  return result.segments.flatMap((s) => (s.kind === 'content' ? s.content : []));
}

/** All client tool calls across a finalized stream, in block order. */
export function toolCallsOf(result: StreamFinalizeResult): ToolCall[] {
  return result.segments.flatMap((s) => (s.kind === 'tool-call' ? [s.toolCall] : []));
}

/**
 * Accumulates a multi-part streaming response keyed by block index.
 * Feed events as they arrive; call `finalize()` to build the completed message.
 */
export interface StreamingMessageAccumulator {
  /**
   * Open a new content block at the given index.
   * Call this when a `content_block_start` event arrives.
   */
  openBlock(index: number, state: BlockAccumulatorState): BlockAccumulator;
  /**
   * Get the accumulator for a block that is already open.
   * Returns undefined if no block exists at the given index.
   */
  getBlock(index: number): BlockAccumulator | undefined;
  /**
   * Finalize the accumulated blocks into a {@link StreamFinalizeResult}: ordered
   * assistant `content` plus the client `toolCalls` to append as `tool-call`
   * messages. JSON input buffers for tool_use / server_tool_use blocks are parsed
   * here. An empty buffer is a legitimate no-argument tool call and finalizes to
   * `{}`; a NON-empty but malformed buffer throws, because a truncated tool call
   * silently degrading to empty input is a dangerous ambiguity for a protocol
   * layer to paper over. Call this when the `message_stop` event arrives.
   */
  finalize(): StreamFinalizeResult;
}

/**
 * Parses a streamed tool-input buffer into a {@link JSONValue}.
 *
 * An empty buffer means no `input_json_delta` arrived, which is exactly how a
 * zero-argument tool call streams — it finalizes to `{}`. A non-empty buffer
 * that is not valid JSON throws, because a partial/corrupt buffer must not
 * silently degrade to empty input. The block name is included to make a corrupt
 * stream diagnosable.
 */
function parseStreamedToolInput(toolName: string, inputBuffer: string): JSONValue {
  // A no-argument tool call produces no input_json_delta; treat that as `{}`
  // rather than throwing on JSON.parse('').
  if (inputBuffer === '') {
    return {};
  }
  try {
    const parsed = parseJSONValue(inputBuffer);
    if (parsed === undefined)
      throw new Error(`Streamed tool input for "${toolName}" is not valid JSON.`);
    return parsed;
  } catch (cause) {
    throw new Error(
      `Streamed tool input for "${toolName}" is not valid JSON; the stream may be incomplete or corrupt.`,
      { cause },
    );
  }
}

function createBlockAccumulator(initial: BlockAccumulatorState): BlockAccumulator {
  let state: BlockAccumulatorState = { ...initial };

  return {
    get state() {
      return state;
    },
    appendTextDelta(delta: string) {
      if (state.type === 'text') {
        state = { ...state, buffer: state.buffer + delta };
      } else if (state.type === 'thinking') {
        state = { ...state, buffer: state.buffer + delta };
      }
    },
    appendCitationsDelta(citation: JSONValue) {
      if (state.type === 'text') {
        state = { ...state, citations: [...(state.citations ?? []), citation] };
      }
    },
    appendThinkingDelta(delta: string) {
      if (state.type === 'thinking') {
        state = { ...state, buffer: state.buffer + delta };
      }
    },
    appendSignatureDelta(delta: string) {
      // Only thinking blocks receive a streamed signature_delta; accumulate the
      // chunks. A redacted_thinking block's encrypted `data` is seeded at openBlock.
      if (state.type === 'thinking') {
        state = { ...state, signature: state.signature + delta };
      }
    },
    appendInputJsonDelta(delta: string) {
      if (state.type === 'tool_use' || state.type === 'server_tool_use') {
        state = { ...state, inputBuffer: state.inputBuffer + delta };
      }
    },
  };
}

/**
 * Creates a new `StreamingMessageAccumulator` for accumulating a multi-part
 * streamed Anthropic response.
 *
 * @example
 * ```ts
 * import { createStreamingAccumulator } from 'conversationalist';
 *
 * const acc = createStreamingAccumulator();
 *
 * // On content_block_start for a text block at index 0:
 * acc.openBlock(0, { type: 'text', buffer: '' });
 *
 * // On text_delta:
 * acc.getBlock(0)?.appendTextDelta(delta.text);
 *
 * // On content_block_start for a tool_use block at index 1:
 * acc.openBlock(1, { type: 'tool_use', id: 'call-1', name: 'my_tool', inputBuffer: '' });
 *
 * // On input_json_delta:
 * acc.getBlock(1)?.appendInputJsonDelta(delta.partial_json);
 *
 * // On message_stop: append each segment in order to preserve block order and
 * // keep tool-call/tool-result pairing intact.
 * const { segments } = acc.finalize();
 * for (const segment of segments) {
 *   conversation =
 *     segment.kind === 'content'
 *       ? appendMessages(conversation, { role: 'assistant', content: segment.content })
 *       : appendMessages(conversation, { role: 'tool-call', content: '', toolCall: segment.toolCall });
 * }
 * ```
 */
function finalizeContentState(
  state: Exclude<BlockAccumulatorState, { type: 'tool_use' } | { type: 'server_tool_use' }>,
): MultiModalContent {
  switch (state.type) {
    case 'text':
      return {
        type: 'text',
        text: state.buffer,
        ...(state.citations !== undefined ? { citations: state.citations } : {}),
      };
    case 'thinking':
      return { type: 'thinking', thinking: state.buffer, signature: state.signature };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: state.data };
    case 'web_search_tool_result':
      return {
        type: 'web_search_tool_result',
        tool_use_id: state.tool_use_id,
        content: state.content,
      };
    default:
      return { type: state.type, tool_use_id: state.tool_use_id, content: state.content };
  }
}

export function createStreamingAccumulator(): StreamingMessageAccumulator {
  const blocks = new Map<number, BlockAccumulator>();

  return {
    openBlock(index: number, state: BlockAccumulatorState): BlockAccumulator {
      const accumulator = createBlockAccumulator(state);
      blocks.set(index, accumulator);
      return accumulator;
    },
    getBlock(index: number): BlockAccumulator | undefined {
      return blocks.get(index);
    },
    finalize(): StreamFinalizeResult {
      const segments: StreamSegment[] = [];
      let currentContent: MultiModalContent[] = [];
      const flushContent = () => {
        if (currentContent.length > 0) {
          segments.push({ kind: 'content', content: currentContent });
          currentContent = [];
        }
      };
      const sortedIndices = [...blocks.keys()].toSorted((a, b) => a - b);
      for (const index of sortedIndices) {
        const block = blocks.get(index);
        if (!block) continue;
        const state = block.state;
        if (state.type === 'tool_use') {
          flushContent();
          segments.push({
            kind: 'tool-call',
            toolCall: {
              id: state.id,
              name: state.name,
              arguments: parseStreamedToolInput(state.name, state.inputBuffer),
            },
          });
          continue;
        }
        if (state.type === 'server_tool_use') {
          currentContent.push({
            type: 'server_tool_use',
            id: state.id,
            name: state.name,
            input: parseStreamedToolInput(state.name, state.inputBuffer),
          });
          continue;
        }
        currentContent.push(finalizeContentState(state));
      }
      flushContent();
      return { segments };
    },
  };
}
