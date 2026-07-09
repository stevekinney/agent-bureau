import type {
  JSONPrimitive as SharedJSONPrimitive,
  JSONValue as SharedJSONValue,
  ToolAction as SharedToolAction,
  ToolActionInput as SharedToolActionInput,
  ToolCall as SharedToolCall,
  ToolCallInput as SharedToolCallInput,
  ToolError as SharedToolError,
  ToolErrorCategory as SharedToolErrorCategory,
  ToolErrorInput as SharedToolErrorInput,
  ToolResult as SharedToolResult,
  ToolResultInput as SharedToolResultInput,
} from 'interoperability';

import type { MultiModalContent } from './multi-modal';

/**
 * Current schema version for serialized conversation data.
 * Increment when making breaking changes to the schema.
 */
export const CURRENT_SCHEMA_VERSION = 5;

/**
 * JSON-serializable value types.
 */
export type JSONPrimitive = SharedJSONPrimitive;
export type JSONValue = SharedJSONValue;

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
  | 'user'
  | 'assistant'
  | 'system'
  | 'developer'
  | 'tool-call'
  | 'tool-result'
  | 'snapshot';

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
 * A plugin that can transform a MessageInput before it is appended.
 */
export type MessagePlugin = (input: MessageInput) => MessageInput;

/**
 * Serialized form of a single node in the conversation tree.
 */
export interface ConversationNodeSnapshot {
  conversation: ConversationHistory;
  children: ConversationNodeSnapshot[];
}

/**
 * Serialized form of the entire conversation tree.
 */
export interface ConversationSnapshot {
  root: ConversationNodeSnapshot;
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
