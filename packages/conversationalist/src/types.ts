import type { MultiModalContent } from '@lasercat/homogenaize';

/**
 * Current schema version for serialized conversation data.
 * Increment when making breaking changes to the schema.
 */
export const CURRENT_SCHEMA_VERSION = 3;

/**
 * JSON-serializable value types.
 */
export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue };

/**
 * Supported message roles in a conversation.
 */
export type MessageRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'developer'
  | 'tool-use'
  | 'tool-result'
  | 'snapshot';

/**
 * Tool call metadata for tool-use messages.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: JSONValue;
}

/**
 * Tool execution result metadata for tool-result messages.
 */
export interface ToolResult {
  callId: string;
  outcome: 'success' | 'error';
  content: JSONValue;
}

/**
 * Token usage accounting for a message.
 */
export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
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
 * Immutable conversation state.
 */
export interface Conversation {
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
 * A plugin that can transform a MessageInput before it is appended.
 */
export type MessagePlugin = (input: MessageInput) => MessageInput;

/**
 * Serialized form of a single node in the conversation history tree.
 */
export interface HistoryNodeSnapshot {
  conversation: Conversation;
  children: HistoryNodeSnapshot[];
}

/**
 * Serialized form of the entire conversation history.
 */
export interface ConversationHistorySnapshot {
  root: HistoryNodeSnapshot;
  currentPath: number[];
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
