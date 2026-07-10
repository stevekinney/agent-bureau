import type { DetectionResult, DetectorContext, InputDetector } from '../types';

/** Default maximum input length in characters. */
const DEFAULT_MAX_LENGTH = 10_000;

/** Options for configuring the input length detector. */
export interface InputLengthDetectorOptions {
  maxLength?: number;
}

/**
 * Creates a detector that triggers when user input exceeds a character length limit.
 *
 * Returns confidence 1.0 when triggered because length violations are deterministic.
 * Defaults to a 10,000 character limit.
 */
export function createInputLengthDetector(options: InputLengthDetectorOptions = {}): InputDetector {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  return {
    name: 'input-length',
    detect(input: string, _context: DetectorContext): Promise<DetectionResult> {
      if (input.length > maxLength) {
        return Promise.resolve({
          triggered: true,
          confidence: 1.0,
          category: 'input-length',
          detail: `Input length ${input.length} exceeds maximum ${maxLength}`,
        });
      }

      return Promise.resolve({ triggered: false, confidence: 0, category: 'input-length' });
    },
  };
}
