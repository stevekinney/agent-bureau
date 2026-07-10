import type { DetectionResult, DetectorContext, InputDetector } from './types';

/** The highest-confidence detector that triggered, or `undefined` if none did. */
export interface DetectorPipelineResult {
  result: DetectionResult;
  detectorName: string;
}

/**
 * Runs a set of detectors against a piece of content and returns the
 * highest-confidence trigger.
 *
 * In `'parallel'` mode (the default) every detector runs concurrently and the
 * result with the highest `confidence` among triggered detectors wins. In
 * `'sequential'` mode detectors run in order and the pipeline stops at the
 * first trigger.
 *
 * Detector errors are caught (via `Promise.allSettled` in parallel mode, a
 * `try`/`catch` in sequential mode) so a broken detector never crashes the
 * caller — this is the shared "detector pipeline" reused by the input
 * guardrail hook (operative) and by content scanning at retrieval surfaces
 * (memory recall, ingested documents, skill resources).
 */
export async function runDetectorPipeline(
  input: string,
  detectors: readonly InputDetector[],
  context: DetectorContext,
  mode: 'parallel' | 'sequential' = 'parallel',
): Promise<DetectorPipelineResult | undefined> {
  let topResult: DetectorPipelineResult | undefined;

  if (mode === 'sequential') {
    for (const detector of detectors) {
      try {
        const result = await detector.detect(input, context);
        if (result.triggered) {
          topResult = { result, detectorName: detector.name };
          break;
        }
      } catch {
        // Detector errors must not crash the caller.
      }
    }
    return topResult;
  }

  const settled = await Promise.allSettled(
    detectors.map(async (detector) => ({
      result: await detector.detect(input, context),
      detectorName: detector.name,
    })),
  );

  for (const outcome of settled) {
    if (outcome.status === 'fulfilled' && outcome.value.result.triggered) {
      if (!topResult || outcome.value.result.confidence > topResult.result.confidence) {
        topResult = outcome.value;
      }
    }
  }

  return topResult;
}
