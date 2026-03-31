import type { DetectionResult, DetectorContext, InputDetector } from '../types';

/**
 * Default patterns that indicate prompt injection attempts.
 *
 * Grouped by category: system prompt overrides, role confusion, and delimiter injection.
 */
const DEFAULT_PATTERNS: RegExp[] = [
  // System prompt overrides
  /ignore\s+(?:all\s+)?previous\s+(?:instructions|directives)/i,
  /disregard\s+the\s+above/i,
  /forget\s+your\s+instructions/i,
  /new\s+instructions\s*:/i,

  // Role confusion
  /\byou\s+are\s+now\b/i,
  /\bact\s+as\b/i,
  /\bpretend\s+you\s+are\b/i,
  /\[SYSTEM\]/i,
  /\[INST\]/i,
  /<\|system\|>/i,

  // Delimiter injection followed by instruction-like text
  /^#{3,}\s+\S/m,
  /^-{3,}\s+\S/m,
];

/** Options for customizing the prompt injection detector. */
export interface PromptInjectionDetectorOptions {
  additionalPatterns?: RegExp[];
}

/**
 * Creates a detector that pattern-matches user input for known prompt injection techniques.
 *
 * Confidence scales with the number of matched patterns: 1 match = 0.3, 2 = 0.6, 3+ = 0.9.
 * Custom patterns extend the default set rather than replacing it.
 */
export function createPromptInjectionDetector(
  options: PromptInjectionDetectorOptions = {},
): InputDetector {
  const patterns = [...DEFAULT_PATTERNS, ...(options.additionalPatterns ?? [])];

  return {
    name: 'prompt-injection',
    detect(input: string, _context: DetectorContext): Promise<DetectionResult> {
      if (!input) {
        return Promise.resolve({ triggered: false, confidence: 0, category: 'prompt-injection' });
      }

      let matchCount = 0;
      const matchedDetails: string[] = [];

      for (const pattern of patterns) {
        // Reset lastIndex to avoid stateful /g or /y regexes missing matches
        // on subsequent calls (user-provided additionalPatterns may carry flags).
        pattern.lastIndex = 0;
        if (pattern.test(input)) {
          matchCount++;
          matchedDetails.push(pattern.source);
        }
      }

      if (matchCount === 0) {
        return Promise.resolve({ triggered: false, confidence: 0, category: 'prompt-injection' });
      }

      const confidence = matchCount >= 3 ? 0.9 : matchCount * 0.3;

      return Promise.resolve({
        triggered: true,
        confidence,
        category: 'prompt-injection',
        detail: `Matched ${matchCount} injection pattern(s): ${matchedDetails.join(', ')}`,
      });
    },
  };
}
