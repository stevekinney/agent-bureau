import type {
  TextBlockParam,
  WebSearchResultBlockParam,
  WebSearchToolRequestError,
  WebSearchToolResultBlockParamContent,
} from '@anthropic-ai/sdk/resources/messages';

/**
 * Type guard for the currently documented {@link WebSearchToolRequestError}
 * `error_code` values. Unknown values are rejected at the provider boundary.
 */
function isWebSearchToolErrorCode(value: string): value is WebSearchToolRequestError['error_code'] {
  switch (value) {
    case 'invalid_tool_input':
    case 'unavailable':
    case 'max_uses_exceeded':
    case 'too_many_requests':
    case 'query_too_long':
      return true;
    default:
      return false;
  }
}

function isWebSearchToolRequestError(value: unknown): value is WebSearchToolRequestError {
  return (
    isRecord(value) &&
    value['type'] === 'web_search_tool_result_error' &&
    typeof value['error_code'] === 'string' &&
    isWebSearchToolErrorCode(value['error_code'])
  );
}

function isWebSearchResultBlockParam(value: unknown): value is WebSearchResultBlockParam {
  return (
    isRecord(value) &&
    value['type'] === 'web_search_result' &&
    typeof value['encrypted_content'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['url'] === 'string' &&
    (value['page_age'] === undefined ||
      value['page_age'] === null ||
      typeof value['page_age'] === 'string')
  );
}

/**
 * Narrows the opaque `content` payload preserved on a
 * {@link AnthropicWebSearchToolResultBlock} to the shape the Anthropic SDK's
 * request param type requires: either an array of web search results or a
 * tool-error object.
 */
export function toSdkWebSearchToolResultContent(
  content: unknown,
): WebSearchToolResultBlockParamContent {
  if (isWebSearchToolRequestError(content)) return content;
  if (Array.isArray(content) && content.every(isWebSearchResultBlockParam)) return content;
  throw new TypeError(
    'Anthropic SDK web_search_tool_result content must be an array of web search results or a tool-error object.',
  );
}

export function isAnthropicImageMediaType(
  mediaType: string,
): mediaType is 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType);
}

export function toSdkCitations(
  citations: unknown,
): NonNullable<TextBlockParam['citations']> | null {
  if (citations === null) return null;
  if (!Array.isArray(citations)) {
    throw new TypeError('Anthropic SDK citations must be an array or null.');
  }

  return citations.map((citation, index) => {
    if (!isRecord(citation) || typeof citation['type'] !== 'string') {
      throw new TypeError(`Invalid Anthropic citation at index ${index}.`);
    }

    switch (citation['type']) {
      case 'char_location':
        return {
          type: 'char_location' as const,
          cited_text: requiredString(citation, 'cited_text', index),
          document_index: requiredNumber(citation, 'document_index', index),
          document_title: nullableString(citation, 'document_title', index),
          end_char_index: requiredNumber(citation, 'end_char_index', index),
          start_char_index: requiredNumber(citation, 'start_char_index', index),
        };
      case 'page_location':
        return {
          type: 'page_location' as const,
          cited_text: requiredString(citation, 'cited_text', index),
          document_index: requiredNumber(citation, 'document_index', index),
          document_title: nullableString(citation, 'document_title', index),
          end_page_number: requiredNumber(citation, 'end_page_number', index),
          start_page_number: requiredNumber(citation, 'start_page_number', index),
        };
      case 'content_block_location':
        return {
          type: 'content_block_location' as const,
          cited_text: requiredString(citation, 'cited_text', index),
          document_index: requiredNumber(citation, 'document_index', index),
          document_title: nullableString(citation, 'document_title', index),
          end_block_index: requiredNumber(citation, 'end_block_index', index),
          start_block_index: requiredNumber(citation, 'start_block_index', index),
        };
      case 'web_search_result_location':
        return {
          type: 'web_search_result_location' as const,
          cited_text: requiredString(citation, 'cited_text', index),
          encrypted_index: requiredString(citation, 'encrypted_index', index),
          title: nullableString(citation, 'title', index),
          url: requiredString(citation, 'url', index),
        };
      case 'search_result_location':
        return {
          type: 'search_result_location' as const,
          cited_text: requiredString(citation, 'cited_text', index),
          end_block_index: requiredNumber(citation, 'end_block_index', index),
          search_result_index: requiredNumber(citation, 'search_result_index', index),
          source: requiredString(citation, 'source', index),
          start_block_index: requiredNumber(citation, 'start_block_index', index),
          title: nullableString(citation, 'title', index),
        };
      default:
        throw new TypeError(`Unsupported Anthropic citation type ${citation['type']}.`);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requiredString(record: Record<string, unknown>, key: string, index: number): string {
  const value = record[key];
  if (typeof value !== 'string') throw new TypeError(`Invalid ${key} in citation ${index}.`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string, index: number): number {
  const value = record[key];
  if (typeof value !== 'number') throw new TypeError(`Invalid ${key} in citation ${index}.`);
  return value;
}

function nullableString(
  record: Record<string, unknown>,
  key: string,
  index: number,
): string | null {
  const value = record[key];
  if (value === null || typeof value === 'string') return value;
  throw new TypeError(`Invalid ${key} in citation ${index}.`);
}
