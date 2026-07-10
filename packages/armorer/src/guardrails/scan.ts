import { runDetectorPipeline } from './pipeline';
import type { DetectorContext, GuardrailTriggeredEvent, InputDetector } from './types';

/** Options for `scanContent`. */
export interface ScanContentOptions {
  /** Detectors to run against the content. */
  detectors: readonly InputDetector[];
  /**
   * Action to take when a detector trips. Default: `'block'`.
   *
   * - `'block'`: the content is dropped (an empty string is returned and
   *   `blocked` is `true`).
   * - `'warn'`: the content passes through unchanged, but `triggered` is
   *   `true` and `onTriggered` fires — use this to flag rather than block.
   * - `'sanitize'`: the content is replaced with the triggering detector's
   *   `sanitized` value, when the detector provided one; otherwise this
   *   falls back to `'block'`.
   * - `'tripwire'`: same as `'block'`, but callers are expected to inspect
   *   `triggered`/`event` and throw their own tripwire error — `scanContent`
   *   itself never throws, so a single content-scanning primitive works for
   *   both the run-halting and pass-through composition models.
   */
  action?: 'block' | 'warn' | 'sanitize' | 'tripwire';
  /** Run detectors in parallel (default) or sequentially. */
  mode?: 'parallel' | 'sequential';
  /** Called when a detector trips. */
  onTriggered?: (event: GuardrailTriggeredEvent) => void;
}

/** Result of scanning a piece of content. */
export interface ScanContentResult {
  /** Whether any detector triggered. */
  triggered: boolean;
  /** Whether the content should be dropped from the surface returning it. */
  blocked: boolean;
  /** The content to use going forward: original, sanitized, or `''` when blocked. */
  content: string;
  /** The triggering event, present only when `triggered` is `true`. */
  event?: GuardrailTriggeredEvent;
}

/**
 * The confidence-gate wrapper around `runDetectorPipeline`: runs detectors
 * against `content`, picks the highest-confidence trigger, builds a
 * `GuardrailTriggeredEvent` tagged with `context.provenance`, and applies the
 * configured `action`.
 *
 * This is the primitive reused directly by retrieval surfaces — memory
 * recall, ingested documents, and skill resources — that scan content before
 * it enters the model's context but that aren't shaped like operative's
 * `PrepareStepHook` (they don't have a `GenerateResponse` to short-circuit,
 * just a piece of retrieved text to admit, flag, or drop).
 */
export async function scanContent(
  content: string,
  context: DetectorContext,
  options: ScanContentOptions,
): Promise<ScanContentResult> {
  const { detectors, action = 'block', mode = 'parallel', onTriggered } = options;

  const top = await runDetectorPipeline(content, detectors, context, mode);
  if (!top) {
    return { triggered: false, blocked: false, content };
  }

  const event: GuardrailTriggeredEvent = {
    detector: top.detectorName,
    category: top.result.category,
    confidence: top.result.confidence,
    action,
    input: content,
    detail: top.result.detail,
    provenance: context.provenance,
  };

  onTriggered?.(event);

  if (action === 'warn') {
    return { triggered: true, blocked: false, content, event };
  }

  if (action === 'sanitize' && top.result.sanitized) {
    return { triggered: true, blocked: false, content: top.result.sanitized, event };
  }

  // 'block' and 'tripwire' (and 'sanitize' with no sanitized text) drop the content.
  return { triggered: true, blocked: true, content: '', event };
}
