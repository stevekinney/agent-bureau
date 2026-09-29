import type {
  JSONValue,
  ToolAction as SharedToolAction,
  ToolActionInput as SharedToolActionInput,
  ToolCall as SharedToolCall,
  ToolCallInput as SharedToolCallInput,
  ToolError as SharedToolError,
  ToolErrorCategory as SharedToolErrorCategory,
  ToolErrorInput as SharedToolErrorInput,
  ToolResult as SharedToolResult,
  ToolResultInput as SharedToolResultInput,
} from '@lostgradient/tool-protocol';

import type { MultiModalContent } from './multi-modal';

/**
 * Current schema version for serialized conversation data.
 * Increment when making breaking changes to the schema.
 */
export const CURRENT_SCHEMA_VERSION = 5;

/** Shared JSON value types have one definition in @lostgradient/tool-protocol. */
export type { JSONPrimitive, JSONValue } from '@lostgradient/tool-protocol';

export type ConversationProvider = 'openai' | 'anthropic' | 'gemini';
export type ChatMessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  role: ChatMessageRole;
  content: string | MultiModalContent[];
}

/**
 * Supported message roles in a conversation.
 */
export type MessageRole =
  'user' | 'assistant' | 'system' | 'developer' | 'tool-call' | 'tool-result' | 'snapshot';

/**
 * Tool call metadata for tool-call messages.
 */
export type ToolCall = SharedToolCall;

/**
 * Tool call input compatible with external tool call parsers.
 */
export type ToolCallInput = SharedToolCallInput;

export type ToolErrorCategory = SharedToolErrorCategory;

export type ToolError = SharedToolError;
export type ToolErrorInput = SharedToolErrorInput;

export type ToolAction = SharedToolAction;
export type ToolActionInput = SharedToolActionInput;

/**
 * Public input shape accepted by tool-call append helpers.
 * Compatible with external tool parsers and armorer tool calls.
 */
export type AppendableToolCallInput = SharedToolCallInput;

/**
 * Public input shape accepted by tool-result append helpers.
 * Compatible with armorer tool results and other external tool executors.
 */
export type AppendableToolError = SharedToolErrorInput;
export type AppendableToolAction = SharedToolActionInput;
export type AppendableToolResult = SharedToolResultInput;

/**
 * Tool execution result metadata for tool-result messages.
 */
export type ToolResult = SharedToolResult;
export type ToolResultInput = SharedToolResultInput;

/**
 * Token usage accounting for a message.
 *
 * `cacheReadTokens` and `cacheCreationTokens` are provider-neutral counters for
 * prompt-cache activity (Anthropic's `cache_read_input_tokens` /
 * `cache_creation_input_tokens`, OpenAI's `prompt_tokens_details.cached_tokens`
 * split into a read count with no creation counterpart). A provider that has no
 * native concept of cache tokens — or a response that didn't report them —
 * leaves these fields `undefined`. They are never fabricated as `0`; callers
 * must treat "absent" and "zero" as distinct.
 */
export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  /** Tokens written to the prompt cache on this request. Anthropic only. */
  cacheCreationTokens?: number | undefined;
  /** Tokens served from the prompt cache on this request. */
  cacheReadTokens?: number | undefined;
}

/**
 * Mutable input shape for creating a message.
 */
export interface MessageInput {
  role: MessageRole;
  content: string | MultiModalContent[];
  metadata?: Record<string, JSONValue> | undefined;
  hidden?: boolean | undefined;
  toolCall?: ToolCall | undefined;
  toolResult?: ToolResult | undefined;
  tokenUsage?: TokenUsage | undefined;
  /** Indicates if this message represents goal completion (assistant only) */
  goalCompleted?: boolean | undefined;
  /**
   * Marks this message as a prompt-cache boundary: everything up to and
   * including this message is a stable prefix a provider can cache.
   * First-class on the conversation model so it survives history
   * serialization round-trips (schemas.ts, JSON, markdown) without a
   * parallel annotated-message wrapper. Provider adapters translate the
   * mark to their native form — Anthropic lowers it to `cache_control` on
   * the message's last content block; OpenAI and Gemini have no per-message
   * cache-control primitive, so their adapters treat it as a documented
   * no-op (OpenAI caches automatically; Gemini uses an out-of-band
   * `cachedContent` resource, not a message annotation).
   */
  cacheBoundary?: boolean | undefined;
}

/**
 * Immutable message shape exposed by the library.
 */
export interface Message {
  id: string;
  role: MessageRole;
  content: string | ReadonlyArray<MultiModalContent>;
  position: number;
  createdAt: string;
  metadata: Readonly<Record<string, JSONValue>>;
  hidden: boolean;
  toolCall?: Readonly<ToolCall> | undefined;
  toolResult?: Readonly<ToolResult> | undefined;
  tokenUsage?: Readonly<TokenUsage> | undefined;
  /** See {@link MessageInput.cacheBoundary}. */
  cacheBoundary?: boolean | undefined;
}

/**
 * Assistant-only message shape with optional goal completion metadata.
 */
export interface AssistantMessage extends Message {
  role: 'assistant';
  /** Indicates if this message represents goal completion */
  goalCompleted?: boolean | undefined;
}

/**
 * Status values for a conversation lifecycle.
 */
export type ConversationStatus = 'active' | 'archived' | 'deleted';

/**
 * Immutable conversation transcript state.
 */
export interface ConversationHistory {
  schemaVersion: number;
  id: string;
  title?: string | undefined;
  status: ConversationStatus;
  metadata: Readonly<Record<string, JSONValue>>;
  ids: ReadonlyArray<string>;
  messages: Readonly<Record<string, Message>>;
  createdAt: string;
  updatedAt: string;
}

/**
 * A function that estimates the number of tokens in a message.
 */
export type TokenEstimator = (message: Message) => number;

/**
 * A function that estimates the number of tokens in a list of messages.
 */
export type ConversationTokenEstimator = (messages: ReadonlyArray<Message>) => number;

/**
 * A function that asynchronously estimates the number of tokens in a list of messages.
 */
export type AsyncConversationTokenEstimator = (messages: ReadonlyArray<Message>) => Promise<number>;

/**
 * A deterministic, side-effect-free plugin that can transform a MessageInput
 * before it is appended or immutably updated. Plugins used by transcript
 * mutation helpers must also be idempotent.
 */
export interface MessagePlugin {
  (input: MessageInput): MessageInput;
  readonly id?: string | undefined;
  readonly revision?: number | undefined;
}

export interface MessagePluginIdentity {
  readonly id: string;
  readonly revision: number;
  readonly authority: 'transcript-transform';
}

/** A conversation's fields other than its ordered messages, as stored on each snapshot node. */
export type ConversationHistoryHeader = Omit<ConversationHistory, 'ids' | 'messages'>;

/**
 * Serialized form of a single node in the conversation tree (snapshot format
 * version 2).
 *
 * A node stores its conversation relative to its parent: the first
 * `retainedMessageCount` of the parent's message ids, then `appendedMessageIds`.
 * `messageReferences` maps the ids whose message differs from the parent's (or
 * that the parent lacks) to an index in {@link ConversationSnapshot.messages};
 * every other id resolves to the parent's message. The root has no parent, so
 * it retains nothing and references every message.
 */
export interface ConversationNodeSnapshot {
  id: string;
  revision: number;
  parentId: string | null;
  conversation: ConversationHistoryHeader;
  retainedMessageCount: number;
  appendedMessageIds: readonly string[];
  messageReferences: Readonly<Record<string, number>>;
}

/**
 * Serialized form of the entire conversation tree (snapshot format version 2).
 *
 * Each distinct message is stored once in `messages`; nodes reference it by
 * index, so a snapshot grows with the number of distinct messages and
 * per-node changes rather than with every node's full transcript. `nodes` is
 * flat and pre-ordered: the root comes first, every other node follows its
 * parent, and siblings appear in child order, which `currentPath` indexes.
 */
export interface ConversationSnapshot {
  snapshotFormatVersion: 2;
  conversationSchemaVersion: number;
  controllerRevision: number;
  conversationId: string;
  currentBranchId: string;
  messages: readonly Message[];
  nodes: readonly ConversationNodeSnapshot[];
  currentPath: readonly number[];
  createdAt: string;
  lineage: ConversationSnapshotLineage;
  integrity: ConversationSnapshotIntegrity;
}

/** Fork and prune lineage carried by every snapshot format version. */
export interface ConversationSnapshotLineage {
  parentConversationId?: string;
  forkPointMessageId?: string;
  sourceRevision?: number;
  retainedFloorNodeId: string;
  removedNodeIds: readonly string[];
}

/** Integrity evidence carried by every snapshot format version. */
export interface ConversationSnapshotIntegrity {
  algorithm: 'fnv1a-64';
  digest: string;
}

/**
 * Serialized form of a single node in snapshot format version 1, in which
 * every node carries its complete conversation.
 */
export interface ConversationNodeSnapshotV1 {
  id: string;
  revision: number;
  parentId: string | null;
  conversation: ConversationHistory;
  children: readonly ConversationNodeSnapshotV1[];
}

/**
 * Snapshot format version 1. `Conversation.from()` still restores it through
 * `migrateConversationSnapshotV1`; `Conversation.snapshot()` no longer produces it.
 */
export interface ConversationSnapshotV1 {
  snapshotFormatVersion: 1;
  conversationSchemaVersion: number;
  controllerRevision: number;
  conversationId: string;
  currentBranchId: string;
  root: ConversationNodeSnapshotV1;
  currentPath: readonly number[];
  createdAt: string;
  lineage: ConversationSnapshotLineage;
  integrity: ConversationSnapshotIntegrity;
}

/**
 * Base options for all export operations.
 */
export interface ExportOptions {
  /**
   * When true, strips transient metadata (keys starting with '_').
   * @default false
   */
  stripTransient?: boolean;

  /**
   * When false, hidden messages are omitted from export output.
   * @default true
   */
  includeHidden?: boolean;

  /**
   * When true, hidden message content is replaced with a redacted placeholder.
   * Only applies when includeHidden is true.
   * @default false
   */
  redactHiddenContent?: boolean;

  /**
   * Placeholder used when redacting tool or hidden content.
   * @default "[REDACTED]"
   */
  redactedPlaceholder?: string;

  /**
   * When true, redacts tool call arguments with '[REDACTED]'.
   * @default false
   */
  redactToolArguments?: boolean;

  /**
   * When true, redacts tool result content with '[REDACTED]'.
   * @default false
   */
  redactToolResults?: boolean;
}

/**
 * Options for exporting to markdown format.
 */
export interface ToMarkdownOptions extends ExportOptions {
  /**
   * When true, includes YAML frontmatter with full metadata for lossless round-trip.
   * Headers include message ID: `### Role (msg-id)`
   * @default false
   */
  includeMetadata?: boolean;
}
