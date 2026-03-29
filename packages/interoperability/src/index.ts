export type { Embedder, EmbeddingVector } from './embeddings';
export {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from './materialization';
export type { MaterializeToolCallOptions } from './materialization';
export type {
  JSONPrimitive,
  JSONValue,
  ToolAction,
  ToolActionInput,
  ToolCall,
  ToolCallInput,
  ToolError,
  ToolErrorCategory,
  ToolErrorInput,
  ToolResult,
  ToolResultInput,
} from './types';
export type { IncrementalHash } from './hash';
export { createIncrementalHash, sha256Hex, sha256HexSync } from './hash';
