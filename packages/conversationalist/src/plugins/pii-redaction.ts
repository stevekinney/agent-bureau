import type { JSONValue, MessageInput, MessagePlugin } from '../types';

/**
 * Default regex rules for redacting common PII.
 */
export const DEFAULT_PII_RULES = {
  email: {
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replace: '[EMAIL_REDACTED]',
  },
  phone: {
    regex: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replace: '[PHONE_REDACTED]',
  },
  apiKey: {
    regex:
      /(?:[a-zA-Z0-9_-]*(?:api|key|secret|token|password|auth)[a-zA-Z0-9_-]*[:=]\s*["']?)([a-zA-Z0-9._-]{16,})(?:["']?)/gi,
    replace: (match: string, key: string) => match.replace(key, '[KEY_REDACTED]'),
  },
} as const;

/**
 * A single PII redaction rule.
 */
export interface PIIRedactionRule {
  regex: RegExp;
  replace: string | ((match: string, ...groups: string[]) => string);
}

/**
 * Options for configuring PII redaction.
 */
export interface PIIRedactionOptions {
  rules?: Record<string, PIIRedactionRule>;
  excludeRules?: string[];
}

/**
 * Creates a PII redaction function with custom rules.
 */
export function createPIIRedaction(options: PIIRedactionOptions = {}): (text: string) => string {
  const rules = { ...DEFAULT_PII_RULES, ...(options.rules ?? {}) };
  const activeRules = Object.entries(rules).filter(
    ([name]) => !options.excludeRules?.includes(name),
  );

  return (text: string): string => {
    let result = text;
    for (const [, rule] of activeRules) {
      const replacer = rule.replace;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      result = result.replace(rule.regex, replacer as any);
    }
    return result;
  };
}

/**
 * Recursively redacts string leaves in a JSON value using the provided redaction function.
 */
function redactJSONValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactJSONValue(item, redact));
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = redactJSONValue(val, redact);
  }
  return result;
}

/**
 * Creates a PII redaction plugin with custom rules.
 */
export function createPIIRedactionPlugin(options: PIIRedactionOptions = {}): MessagePlugin {
  const redact = createPIIRedaction(options);

  return (input: MessageInput): MessageInput => {
    let result: MessageInput;

    if (typeof input.content === 'string') {
      result = {
        ...input,
        content: redact(input.content),
      };
    } else {
      result = {
        ...input,
        content: input.content.map((part) => {
          switch (part.type) {
            case 'text': {
              // Redact both the visible text and any citation metadata
              // (cited_text, titles, urls) which can carry PII.
              const text = part.text ? redact(part.text) : part.text;
              if (part.citations === undefined) {
                return part.text ? { ...part, text } : part;
              }
              return {
                ...part,
                text,
                citations: redactJSONValue(part.citations, redact) as typeof part.citations,
              };
            }
            case 'server_tool_use':
              // Tool input JSON (e.g. a web_search query) can carry PII.
              return { ...part, input: redactJSONValue(part.input, redact) as typeof part.input };
            case 'web_search_tool_result':
            case 'web_fetch_tool_result':
            case 'code_execution_tool_result':
            case 'bash_code_execution_tool_result':
            case 'text_editor_code_execution_tool_result':
              // Structural tool-result payloads (search snippets, fetched page
              // text, stdout) can contain emails/keys — redact their string
              // leaves like role-level tool results.
              return {
                ...part,
                content: redactJSONValue(part.content, redact) as typeof part.content,
              };
            default:
              // image; container_upload (id only); and intentionally `thinking` /
              // `redacted_thinking`: their text/data is paired byte-for-byte with
              // a signature for extended-thinking replay, so rewriting it would
              // break replay. Thinking content is internal reasoning, not
              // user-facing output, so it is left intact.
              return part;
          }
        }),
      };
    }

    if (result.toolCall?.arguments !== undefined) {
      result = {
        ...result,
        toolCall: {
          ...result.toolCall,
          arguments: redactJSONValue(
            result.toolCall.arguments,
            redact,
          ) as MessageInput['toolCall'] extends { arguments: infer A } ? A : never,
        },
      };
    }

    if (result.toolResult?.content !== undefined) {
      result = {
        ...result,
        toolResult: {
          ...result.toolResult,
          content: redactJSONValue(
            result.toolResult.content,
            redact,
          ) as MessageInput['toolResult'] extends { content: infer C } ? C : never,
        },
      };
    }

    if (result.metadata !== undefined) {
      result = {
        ...result,
        metadata: redactJSONValue(result.metadata, redact) as Record<string, JSONValue>,
      };
    }

    return result;
  };
}

/**
 * Default PII redaction plugin instance.
 */
export const redactPii = createPIIRedactionPlugin();
