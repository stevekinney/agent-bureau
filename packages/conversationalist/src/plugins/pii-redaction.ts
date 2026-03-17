import type { MessageInput, MessagePlugin } from '../types';

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
export function createPIIRedaction(
  options: PIIRedactionOptions = {},
): (text: string) => string {
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
 * Creates a PII redaction plugin with custom rules.
 */
export function createPIIRedactionPlugin(
  options: PIIRedactionOptions = {},
): MessagePlugin {
  const redact = createPIIRedaction(options);

  return (input: MessageInput): MessageInput => {
    if (typeof input.content === 'string') {
      return {
        ...input,
        content: redact(input.content),
      };
    }

    return {
      ...input,
      content: input.content.map((part) => {
        if (part.type === 'text' && part.text) {
          return {
            ...part,
            text: redact(part.text),
          };
        }
        return part;
      }),
    };
  };
}

/**
 * Default PII redaction plugin instance.
 */
export const redactPii = createPIIRedactionPlugin();
