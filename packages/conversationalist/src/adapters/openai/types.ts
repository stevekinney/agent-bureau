export interface OpenAIConversationExportOptions {
  groupToolCalls?: boolean;
}

/**
 * OpenAI text content part.
 */
export interface OpenAITextContentPart {
  type: 'text';
  text: string;
}

/**
 * OpenAI image content part.
 */
export interface OpenAIImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

/**
 * OpenAI content part union type.
 */
export type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart;

/**
 * OpenAI tool call format.
 */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * OpenAI system message format for the Chat Completions API.
 */
export interface OpenAISystemMessage {
  role: 'system';
  content: string | OpenAITextContentPart[];
  name?: string;
}

/**
 * OpenAI user message format for the Chat Completions API.
 */
export interface OpenAIUserMessage {
  role: 'user';
  content: string | OpenAIContentPart[];
  name?: string;
}

/**
 * OpenAI assistant message format for the Chat Completions API.
 */
export interface OpenAIAssistantMessage {
  role: 'assistant';
  content: string | OpenAITextContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
}

/**
 * OpenAI tool message format for the Chat Completions API.
 */
export interface OpenAIToolMessage {
  role: 'tool';
  content: string | OpenAITextContentPart[];
  tool_call_id: string;
}

/**
 * OpenAI message format for the Chat Completions API.
 */
export type OpenAIMessage =
  OpenAISystemMessage | OpenAIUserMessage | OpenAIAssistantMessage | OpenAIToolMessage;
