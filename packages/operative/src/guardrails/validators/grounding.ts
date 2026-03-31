import type { OutputValidator, ValidationResult, ValidatorContext } from '../types';

/** Options for configuring the grounding validator. */
export interface GroundingValidatorOptions {
  /** Conversation text to ground claims against. Accepts a string or a getter
   *  function that returns the current conversation text on each validation call,
   *  which is necessary for live agent sessions where the conversation grows. */
  conversationText?: string | (() => string);
  groundingThreshold?: number;
}

/**
 * Patterns that extract "claim-like" content from model output: URLs, numbers with units,
 * dollar amounts, and quoted text.
 */
const CLAIM_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s)]+/g,
  /\$\d[\d,]*(?:\.\d+)?/g,
  /\b\d[\d,]*(?:\.\d+)?\s*(?:km|mi|meters?|feet|ft|kg|lbs?|pounds?|dollars?|euros?|%|percent|degrees?|°[CF]?|mph|kph|hours?|minutes?|seconds?|days?|years?|months?|weeks?)\b/gi,
  /"[^"]{4,}"/g,
];

/**
 * Extracts claim-like strings from text using heuristic patterns.
 */
function extractClaims(text: string): string[] {
  const claims: string[] = [];
  for (const pattern of CLAIM_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      claims.push(match[0]);
    }
  }
  return claims;
}

/**
 * Checks whether a claim appears in the conversation text.
 *
 * For numeric claims, extracts the numeric part and checks for its presence.
 * For other claims, performs a case-insensitive substring check.
 */
function isGrounded(claim: string, conversationText: string): boolean {
  const lowerConversation = conversationText.toLowerCase();

  // For URLs, check exact match
  if (claim.startsWith('http')) {
    return lowerConversation.includes(claim.toLowerCase());
  }

  // For quoted text, check the inner content
  if (claim.startsWith('"') && claim.endsWith('"')) {
    const inner = claim.slice(1, -1).toLowerCase();
    return lowerConversation.includes(inner);
  }

  // For numbers with units or dollar amounts, extract the numeric core
  const numericMatch = claim.match(/\$?([\d,]+(?:\.\d+)?)/);
  if (numericMatch?.[1]) {
    return lowerConversation.includes(numericMatch[1]);
  }

  return lowerConversation.includes(claim.toLowerCase());
}

/**
 * Creates a validator that checks whether model output claims are grounded in the conversation.
 *
 * Extracts "claim-like" content (URLs, numbers with units, quoted text) from the output
 * and checks whether each claim appears somewhere in the conversation history. When the
 * ratio of grounded claims falls below the threshold, the output is flagged as ungrounded.
 */
export function createGroundingValidator(options: GroundingValidatorOptions = {}): OutputValidator {
  const { conversationText: rawConversationText = '', groundingThreshold = 0.8 } = options;
  const resolveConversationText =
    typeof rawConversationText === 'function' ? rawConversationText : () => rawConversationText;

  return {
    name: 'grounding',
    validate(output: string, _context: ValidatorContext): Promise<ValidationResult> {
      const claims = extractClaims(output);

      if (claims.length === 0) {
        return Promise.resolve({ valid: true, confidence: 0, category: 'grounding' });
      }

      const currentText = resolveConversationText();
      const groundedCount = claims.filter((claim) => isGrounded(claim, currentText)).length;
      const ratio = groundedCount / claims.length;

      if (ratio >= groundingThreshold) {
        return Promise.resolve({ valid: true, confidence: 0, category: 'grounding' });
      }

      return Promise.resolve({
        valid: false,
        confidence: 1 - ratio,
        category: 'grounding',
        detail: `${claims.length - groundedCount} of ${claims.length} claims are ungrounded (ratio: ${ratio.toFixed(2)}, threshold: ${groundingThreshold})`,
      });
    },
  };
}
