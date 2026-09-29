import type { GuardrailProvenance, InputDetector } from 'armorer';

export type GovernedContentScan =
  | { readonly flagged: false }
  | {
      readonly flagged: true;
      readonly detector: string;
      readonly category: string;
      readonly confidence: number;
    };

/**
 * Runs governance detectors in order and stops at the first trip. Unlike the
 * shared guardrail pipeline, which swallows a detector's exception so it never
 * crashes a conversation, governance fails closed: a detector that throws is a
 * detection, because admitting content nobody could scan is exactly the gap a
 * poisoning attempt would aim for. The result never carries the content itself.
 */
export async function scanGovernedContent(
  content: string,
  detectors: readonly InputDetector[],
  provenance: GuardrailProvenance,
): Promise<GovernedContentScan> {
  const context = { step: 0, conversationLength: 0, sessionTainted: false, provenance };
  for (const detector of detectors) {
    try {
      const result = await detector.detect(content, context);
      if (result.triggered) {
        return {
          flagged: true,
          detector: detector.name,
          category: result.category,
          confidence: result.confidence,
        };
      }
    } catch {
      return {
        flagged: true,
        detector: detector.name,
        category: 'detector-failure',
        confidence: 1,
      };
    }
  }
  return { flagged: false };
}
