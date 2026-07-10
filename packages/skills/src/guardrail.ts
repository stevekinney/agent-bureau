import type { DetectorContext, GuardrailTriggeredEvent, InputDetector } from 'armorer';
import { scanContent } from 'armorer';

/**
 * Options for scanning skill content (a skill's body when activated, or a
 * resource file loaded on demand) through the shared `armorer` guardrail
 * detector pipeline before it enters the model's context. This is the same
 * pipeline (and built-in detectors) operative's input guardrail and memory's
 * recall scanning use — reused here rather than duplicated.
 */
export interface SkillGuardrailOptions {
  /** Detectors to run against skill content. */
  detectors: InputDetector[];
  /**
   * `'block'` (default) prevents the flagged content from being returned to
   * the model. `'warn'` returns the content unchanged but still fires
   * `onTriggered`.
   */
  action?: 'block' | 'warn';
  /** Run detectors in parallel (default) or sequentially. */
  mode?: 'parallel' | 'sequential';
  /** Called when a detector trips on skill content. */
  onTriggered?: (event: GuardrailTriggeredEvent) => void;
  /** Getter that returns the current session taint state, if tracked externally. */
  getSessionTainted?: () => boolean;
}

/** Result of scanning a skill's body or a skill resource. */
export interface ScannedSkillContent {
  content: string;
  blocked: boolean;
  flagged: boolean;
  event?: GuardrailTriggeredEvent;
}

/**
 * Runs skill content through the shared detector pipeline, tagging the
 * `DetectorContext` with `'skill-resource'` provenance — distinct from
 * `'user-input'` since skill content is authored by whoever published the
 * skill, not the current session's user.
 */
export async function scanSkillResource(
  content: string,
  options: SkillGuardrailOptions,
): Promise<ScannedSkillContent> {
  const context: DetectorContext = {
    step: 0,
    conversationLength: 0,
    sessionTainted: options.getSessionTainted?.() ?? false,
    provenance: 'skill-resource',
  };

  const result = await scanContent(content, context, {
    detectors: options.detectors,
    action: options.action ?? 'block',
    mode: options.mode,
    onTriggered: options.onTriggered,
  });

  return {
    content: result.content,
    blocked: result.blocked,
    flagged: result.triggered && !result.blocked,
    event: result.event,
  };
}
