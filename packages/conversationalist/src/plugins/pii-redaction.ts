import type { MultiModalContent } from '../multi-modal';
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
  const rules = { ...DEFAULT_PII_RULES, ...options.rules };
  const activeRules = Object.entries(rules).filter(
    ([name]) => !options.excludeRules?.includes(name),
  );

  return (text: string): string => {
    let result = text;
    for (const [, rule] of activeRules) {
      const replacer = rule.replace;
      result =
        typeof replacer === 'string'
          ? result.replace(rule.regex, replacer)
          : result.replace(rule.regex, replacer);
    }
    return result;
  };
}

/**
 * Recursively redacts string leaves in a JSON value using the provided redaction function.
 */
function redactJSONValue(value: JSONValue, redact: (text: string) => string): JSONValue {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (isJSONArray(value)) return value.map((item) => redactJSONValue(item, redact));
  return redactJSONRecord(value, redact);
}

function isJSONArray(value: JSONValue): value is readonly JSONValue[] {
  return Array.isArray(value);
}

function redactJSONRecord(
  value: Record<string, JSONValue>,
  redact: (text: string) => string,
): Record<string, JSONValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, redactJSONValue(nested, redact)]),
  );
}

function redactContentPart(
  part: MultiModalContent,
  redact: (text: string) => string,
): MultiModalContent {
  if (part.type === 'text') {
    const text = part.text ? redact(part.text) : part.text;
    if (part.citations === undefined) return part.text ? { ...part, text } : part;
    return { ...part, text, citations: redactJSONValue(part.citations, redact) };
  }
  if (part.type === 'server_tool_use') {
    return { ...part, input: redactJSONValue(part.input, redact) };
  }
  if ('tool_use_id' in part) {
    return { ...part, content: redactJSONValue(part.content, redact) };
  }
  // Signed thinking payloads must remain byte-for-byte intact for replay.
  // Images, document references and upload identifiers are unchanged.
  return part;
}

/**
 * Creates a PII redaction plugin with custom rules.
 */
export function createPIIRedactionPlugin(options: PIIRedactionOptions = {}): MessagePlugin {
  const redact = createPIIRedaction(options);

  const transform = (input: MessageInput): MessageInput => {
    let result: MessageInput;

    if (typeof input.content === 'string') {
      result = {
        ...input,
        content: redact(input.content),
      };
    } else {
      result = {
        ...input,
        content: input.content.map((part) => redactContentPart(part, redact)),
      };
    }

    if (result.toolCall?.arguments !== undefined) {
      result = {
        ...result,
        toolCall: {
          ...result.toolCall,
          arguments: redactJSONValue(result.toolCall.arguments, redact),
        },
      };
    }

    if (result.toolResult?.content !== undefined) {
      result = {
        ...result,
        toolResult: {
          ...result.toolResult,
          content: redactJSONValue(result.toolResult.content, redact),
        },
      };
    }

    if (result.metadata !== undefined) {
      result = {
        ...result,
        metadata: redactJSONRecord(result.metadata, redact),
      };
    }

    return result;
  };
  return Object.assign(transform, { id: 'pii-redaction', revision: 1 });
}

/**
 * Default PII redaction plugin instance.
 */
export const redactPii = createPIIRedactionPlugin();
