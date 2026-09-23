import {
  type MultiModalContent,
  type ServerToolResultContent,
  type WebSearchToolResultContent,
  renderDocumentReferenceText,
} from '../multi-modal';
import type { Message } from '../types';

const STRIPPED_PLACEHOLDER = '[tool result]';

/**
 * Shrinks structural tool blocks inside a content array before summarization.
 * `compactConversation` passes the result to a summarizer that may re-serialize
 * the chunk through the Anthropic adapter/API, so each block must remain a VALID
 * Anthropic block:
 * - server-tool results / server_tool_use input: the payload is replaced with a
 *   placeholder string (a result block with `content: "[tool result]"` is still
 *   well-formed).
 * - cited text: the `citations` FIELD is removed (not scalarized) — `citations`
 *   must be a structured array/object, so `"[tool result]"` would be malformed.
 * - thinking / redacted_thinking: the whole block is DROPPED — a thinking block
 *   with mutated text no longer matches its signature, and a redacted block with
 *   a placeholder in place of Anthropic's encrypted `data` is invalid, so the
 *   API would reject the summarization request. Internal reasoning need not go to
 *   the summarizer anyway.
 */
function isResultBlock(
  part: MultiModalContent,
): part is WebSearchToolResultContent | ServerToolResultContent {
  switch (part.type) {
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
      return true;
    default:
      return false;
  }
}

function stripBlock(part: MultiModalContent): MultiModalContent[] {
  if (part.type === 'server_tool_use') return [{ ...part, input: STRIPPED_PLACEHOLDER }];
  if (isResultBlock(part)) return [{ ...part, content: STRIPPED_PLACEHOLDER }];
  switch (part.type) {
    case 'text': {
      // Drop the citations field entirely (it must be structured, not a string);
      // keep the visible text.
      if (part.citations === undefined) return [part];
      const { citations: _citations, ...rest } = part;
      return [rest];
    }
    case 'document':
      return [{ type: 'text', text: renderDocumentReferenceText(part) }];
    case 'thinking':
    case 'redacted_thinking':
      // Drop the block — a mutated thinking/redacted block is an invalid
      // Anthropic block and would break re-serialization to the API.
      return [];
    default:
      return [part];
  }
}

function stripStructuralToolBlocks(
  content: string | ReadonlyArray<MultiModalContent>,
): string | MultiModalContent[] {
  if (typeof content === 'string') return content;
  return content.flatMap(stripBlock);
}

export function stripToolResultDetails(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role === 'tool-result' && message.toolResult) {
      return {
        ...message,
        content: STRIPPED_PLACEHOLDER,
        toolResult: {
          ...message.toolResult,
          content: STRIPPED_PLACEHOLDER,
        },
      };
    }
    // Structural tool-result blocks live inside assistant content; strip them too.
    if (typeof message.content !== 'string') {
      return { ...message, content: stripStructuralToolBlocks(message.content) };
    }
    return message;
  });
}
