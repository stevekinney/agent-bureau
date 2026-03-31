import type { DetectionResult, DetectorContext, InputDetector } from '../types';

/** Options for configuring the topic boundary detector. */
export interface TopicBoundaryDetectorOptions {
  allowedTopics: string[];
  blockedKeywords?: string[];
}

/**
 * Creates a detector that enforces topic boundaries via keyword matching.
 *
 * Blocked keywords always trigger regardless of allowed topics. When no blocked keyword
 * matches, the detector checks whether the input contains at least one allowed topic keyword.
 * All matching is case-insensitive.
 */
export function createTopicBoundaryDetector(options: TopicBoundaryDetectorOptions): InputDetector {
  const { allowedTopics, blockedKeywords = [] } = options;

  return {
    name: 'topic-boundary',
    detect(input: string, _context: DetectorContext): Promise<DetectionResult> {
      if (!input) {
        return Promise.resolve({ triggered: false, confidence: 0, category: 'topic-boundary' });
      }

      const lowerInput = input.toLowerCase();

      // Blocked keywords always win
      for (const keyword of blockedKeywords) {
        if (lowerInput.includes(keyword.toLowerCase())) {
          return Promise.resolve({
            triggered: true,
            confidence: 1.0,
            category: 'topic-boundary',
            detail: `Blocked keyword detected: "${keyword}"`,
          });
        }
      }

      // Check if input matches at least one allowed topic
      const matchesAllowedTopic = allowedTopics.some((topic) =>
        lowerInput.includes(topic.toLowerCase()),
      );

      if (matchesAllowedTopic) {
        return Promise.resolve({ triggered: false, confidence: 0, category: 'topic-boundary' });
      }

      return Promise.resolve({
        triggered: true,
        confidence: 0.7,
        category: 'topic-boundary',
        detail: `Input does not match any allowed topic: ${allowedTopics.join(', ')}`,
      });
    },
  };
}
