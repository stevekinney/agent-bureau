/**
 * This file re-exports all utilities from the utilities/ directory.
 * For new code, prefer importing directly from the specific modules:
 * - './utilities/content' for content normalization
 * - './utilities/deterministic' for sort utilities (also exported via conversationalist/sort)
 * - './utilities/markdown' for markdown conversion (exposed via conversationalist/markdown)
 * - './utilities/message' for message utilities
 * - './utilities/tool-calls' for tool call pairing
 * - './utilities/transient' for transient metadata handling
 * - './utilities/type-helpers' for type guard helpers
 */

// Content normalization
export { normalizeContent, toMultiModalArray } from './utilities/content';

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
} from './utilities/message';

// Tool call pairing
export type { ToolCallPair } from './utilities/tool-calls';
export { pairToolCallsWithResults } from './utilities/tool-calls';

// Transient metadata
export {
  isTransientKey,
  stripTransientFromRecord,
  stripTransientMetadata,
} from './utilities/transient';

// Type helpers
export { hasOwnProperty, toReadonly } from './utilities/type-helpers';
