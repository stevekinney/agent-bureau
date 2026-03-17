// Content normalization
export { normalizeContent, toMultiModalArray } from './content';

// Markdown conversion is exported via `conversationalist/markdown`

// Message utilities
export {
  createMessage,
  isAssistantMessage,
  messageHasImages,
  messageParts,
  messageText,
  messageToJSON,
  messageToString,
} from './message';

// Tool call pairing
export type { ToolCallPair } from './tool-calls';
export { pairToolCallsWithResults } from './tool-calls';

// Transient metadata
export {
  isTransientKey,
  stripTransientFromRecord,
  stripTransientMetadata,
} from './transient';

// Type helpers
export { hasOwnProperty, toReadonly } from './type-helpers';
