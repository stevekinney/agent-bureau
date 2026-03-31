import type { OutputValidator, ValidationResult, ValidatorContext } from '../types';

/** Options for configuring the code safety validator. */
export interface CodeSafetyValidatorOptions {
  blockedPatterns?: RegExp[];
}

/**
 * Default patterns that indicate dangerous code in model output.
 *
 * Each pattern is paired with a human-readable label for the detail message.
 */
const DEFAULT_BLOCKED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Destructive file operations
  { pattern: /rm\s+-rf\s+\/(?!\S)/g, label: 'rm -rf /' },
  { pattern: /rm\s+-rf\s+~/g, label: 'rm -rf ~' },
  { pattern: /rm\s+-rf\s+\*/g, label: 'rm -rf *' },

  // Code execution from untrusted input
  { pattern: /\beval\s*\(/g, label: 'eval()' },
  { pattern: /\bexec\s*\(/g, label: 'exec()' },
  { pattern: /\bFunction\s*\(/g, label: 'Function()' },

  // Subprocess execution
  { pattern: /\bsubprocess\./g, label: 'subprocess' },
  { pattern: /\bos\.system\s*\(/g, label: 'os.system()' },

  // Dangerous SQL
  { pattern: /DROP\s+TABLE/gi, label: 'DROP TABLE' },
  { pattern: /DELETE\s+FROM\s+\w+\s*(?:;|$)/gim, label: 'DELETE FROM without WHERE' },

  // Pipe-to-shell
  { pattern: /curl\s+[^|]*\|\s*(?:ba)?sh/gi, label: 'curl | bash' },
  { pattern: /wget\s+[^|]*\|\s*sh/gi, label: 'wget | sh' },
];

/**
 * Creates a validator that checks model-generated code for dangerous patterns.
 *
 * Returns confidence 1.0 for exact pattern matches because they are deterministic.
 * Custom `blockedPatterns` extend the default set rather than replacing it.
 */
export function createCodeSafetyValidator(
  options: CodeSafetyValidatorOptions = {},
): OutputValidator {
  const customPatterns = (options.blockedPatterns ?? []).map((pattern) => ({
    pattern,
    label: `custom: ${pattern.source}`,
  }));

  const allPatterns = [...DEFAULT_BLOCKED_PATTERNS, ...customPatterns];

  return {
    name: 'code-safety',
    validate(output: string, _context: ValidatorContext): Promise<ValidationResult> {
      if (!output) {
        return Promise.resolve({ valid: true, confidence: 0, category: 'code-safety' });
      }

      // Check for DELETE FROM with WHERE (safe) vs without WHERE (unsafe)
      // We need to handle this specially: if DELETE FROM has a WHERE clause, it's safe
      const matchedLabels: string[] = [];

      for (const { pattern, label } of allPatterns) {
        pattern.lastIndex = 0;

        if (label === 'DELETE FROM without WHERE') {
          // Special handling: only flag DELETE FROM when there's no WHERE clause
          const deleteRegex = /DELETE\s+FROM\s+\w+/gi;
          deleteRegex.lastIndex = 0;
          let deleteMatch: RegExpExecArray | null;
          while ((deleteMatch = deleteRegex.exec(output)) !== null) {
            const afterDelete = output.slice(deleteMatch.index + deleteMatch[0].length);
            if (!/^\s+WHERE\b/i.test(afterDelete)) {
              matchedLabels.push(label);
              break;
            }
          }
          continue;
        }

        if (pattern.test(output)) {
          matchedLabels.push(label);
        }
      }

      if (matchedLabels.length === 0) {
        return Promise.resolve({ valid: true, confidence: 0, category: 'code-safety' });
      }

      return Promise.resolve({
        valid: false,
        confidence: 1.0,
        category: 'code-safety',
        detail: `Dangerous code pattern(s) detected: ${matchedLabels.join(', ')}`,
      });
    },
  };
}
