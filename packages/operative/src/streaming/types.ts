import type { TokenUsage } from 'conversationalist';
import type { TypedEventTarget } from 'lifecycle';

/** Discriminator for blocks within a stream. */
export type BlockType = 'text' | 'tool-call' | 'thinking' | 'metadata';

/** A single block tracked by the stream state machine. */
export type StreamBlock = {
  readonly id: string;
  readonly type: BlockType;
  readonly index: number;
  content: string;
  complete: boolean;
  /** For tool-call blocks: the tool name once known. */
  toolName?: string;
  /** For tool-call blocks: partial JSON arguments as they arrive. */
  partialArguments?: string;
};

/** Read-only snapshot of the current stream state. */
export type StreamState = {
  readonly blocks: ReadonlyArray<StreamBlock>;
  readonly activeBlock: StreamBlock | undefined;
  readonly textContent: string;
  readonly toolCalls: ReadonlyArray<StreamBlock>;
  readonly complete: boolean;
  readonly usage?: TokenUsage;
};

/**
 * Discriminated union of all events that flow through the streaming pipeline.
 * Each variant is keyed by its `type` field.
 */
export type StreamEvent =
  | { type: 'stream:block-start'; block: StreamBlock }
  | { type: 'stream:block-delta'; block: StreamBlock; delta: string }
  | { type: 'stream:block-complete'; block: StreamBlock }
  | { type: 'stream:text-delta'; content: string; accumulated: string }
  | { type: 'stream:tool-call-start'; toolName: string; blockId: string }
  | { type: 'stream:tool-call-delta'; toolName: string; partialArguments: string }
  | { type: 'stream:tool-call-complete'; toolName: string; arguments: unknown }
  | { type: 'stream:usage'; usage: TokenUsage }
  | { type: 'stream:complete'; state: StreamState }
  | { type: 'stream:error'; error: unknown };

/** Custom event class wrapping a StreamEvent for use with TypedEventTarget. */
export class StreamCustomEvent<T extends StreamEvent['type'] = StreamEvent['type']> extends Event {
  readonly detail: Extract<StreamEvent, { type: T }>;

  constructor(type: T, detail: Extract<StreamEvent, { type: T }>) {
    super(type);
    this.detail = detail;
  }
}

/** Event map for TypedEventTarget — maps each stream event type to its custom event. */
export type StreamEventMap = {
  [K in StreamEvent['type']]: StreamCustomEvent<K>;
};

/** Options for the enhanced streaming wrapper. */
export type EnhancedStreamingOptions = {
  /** Event target to emit structured stream events on. */
  eventTarget?: TypedEventTarget<StreamEventMap>;
  /** Called with each text delta. */
  onTextDelta?: (delta: string, accumulated: string) => void;
  /** Called when a tool call starts. */
  onToolCallStart?: (toolName: string) => void;
  /** Called with partial tool call arguments. */
  onToolCallDelta?: (toolName: string, partialArgs: string) => void;
};

/** Input commands the state machine accepts. */
export type StreamCommand =
  | { type: 'block-start'; id: string; blockType: BlockType; toolName?: string }
  | { type: 'block-delta'; id: string; delta: string }
  | { type: 'block-complete'; id: string }
  | { type: 'set-usage'; usage: TokenUsage }
  | { type: 'complete' };

/** Interface returned by createStreamStateMachine(). */
export type StreamStateMachine = {
  /** Process a command and return the updated state. */
  process(command: StreamCommand): StreamState;
  /** Get the current state without processing a command. */
  getState(): StreamState;
  /** Reset the state machine to its initial empty state. */
  reset(): void;
};
