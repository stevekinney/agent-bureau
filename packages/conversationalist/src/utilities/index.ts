// Content normalization
export { normalizeContent, toMultiModalArray } from './content';

// Message utilities
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
export type { AppendableMessageInput, MessageBuildEnvironment } from './message';

// Tool call pairing
export {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from '../conversation/tool-interactions';
export type { MaterializeToolCallOptions } from '../conversation/tool-interactions';
export { pairToolCallsWithResults } from './tool-calls';
export type { ToolCallPair } from './tool-calls';

// Transient metadata
export { isTransientKey, stripTransientFromRecord, stripTransientMetadata } from './transient';

// Type helpers
export { deepFreeze, hasOwnProperty, toReadonly } from './type-helpers';
