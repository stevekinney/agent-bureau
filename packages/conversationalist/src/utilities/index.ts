// Content normalization
export { normalizeContent, toMultiModalArray } from './content';

// Markdown conversion is exported via `conversationalist/markdown`

// Message utilities
export type { MessageBuildEnvironment } from './message';
export {
  buildMessageFromInput,
  createMessage,
  isAssistantMessage,
  messageHasImages,
  messageParts,
  messageText,
  messageToJSON,
  messageToString,
  repositionMessage,
} from './message';

// Tool call pairing
export type { MaterializeToolCallOptions } from '../conversation/tool-interactions';
export {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from '../conversation/tool-interactions';
export type { ToolCallPair } from './tool-calls';
export { pairToolCallsWithResults } from './tool-calls';

// Transient metadata
export { isTransientKey, stripTransientFromRecord, stripTransientMetadata } from './transient';

// Type helpers
export { hasOwnProperty, toReadonly } from './type-helpers';
