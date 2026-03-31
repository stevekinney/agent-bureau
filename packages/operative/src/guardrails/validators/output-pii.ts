import type { OutputValidator, ValidationResult, ValidatorContext } from '../types';

type PIIRule =
  | { regex: RegExp; replace: string }
  | { regex: RegExp; replace: (match: string, key: string) => string };

/**
 * PII redaction rules duplicated from conversationalist's PII redaction plugin.
 *
 * These are intentionally duplicated rather than imported to keep the operative
 * package independent of conversationalist at runtime.
 */
const PII_RULES: Record<string, PIIRule> = {
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
};

/**
 * Checks whether any PII pattern matches in the given text.
 */
function containsPII(text: string): boolean {
  for (const rule of Object.values(PII_RULES)) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Redacts all PII from the given text using the built-in rules.
 */
function redactPII(text: string): string {
  let result = text;
  for (const rule of Object.values(PII_RULES)) {
    rule.regex.lastIndex = 0;
    if (typeof rule.replace === 'string') {
      result = result.replace(rule.regex, rule.replace);
    } else {
      result = result.replace(rule.regex, rule.replace);
    }
  }
  return result;
}

/**
 * Creates a validator that detects PII (emails, phone numbers, API keys) in model output.
 *
 * When PII is found, the validator returns `valid: false` with a `redacted` version of the
 * output where PII has been replaced with placeholder tokens like `[EMAIL_REDACTED]`.
 */
export function createOutputPIIValidator(): OutputValidator {
  return {
    name: 'output-pii',
    validate(output: string, _context: ValidatorContext): Promise<ValidationResult> {
      if (!containsPII(output)) {
        return Promise.resolve({ valid: true, confidence: 0, category: 'pii' });
      }

      return Promise.resolve({
        valid: false,
        confidence: 1.0,
        category: 'pii',
        detail: 'PII detected in model output',
        redacted: redactPII(output),
      });
    },
  };
}
