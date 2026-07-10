/**
 * Provenance of content passed through a guardrail detector.
 *
 * `'user-input'` is content a human typed directly into the conversation.
 * The other three tags mark content that entered the conversation via
 * retrieval — a distinct trust boundary from user input, since it was
 * authored by someone (or something) other than the current session's user
 * and may have been crafted specifically to manipulate the model.
 */
export type GuardrailProvenance =
  | 'user-input'
  | 'recalled-memory'
  | 'ingested-document'
  | 'skill-resource';

/** Context provided to detectors for situational awareness. */
export interface DetectorContext {
  step: number;
  conversationLength: number;
  sessionTainted: boolean;
  /** Where the content being scanned originated from. */
  provenance: GuardrailProvenance;
}

/** Result of running a detector against a piece of content. */
export interface DetectionResult {
  triggered: boolean;
  confidence: number;
  category: string;
  detail?: string;
  /** Sanitized version of the input (used when action='sanitize'). */
  sanitized?: string;
}

/** A detector that inspects content for policy violations. */
export interface InputDetector {
  name: string;
  detect: (input: string, context: DetectorContext) => Promise<DetectionResult>;
}

/** Event emitted when a guardrail detector trips. */
export interface GuardrailTriggeredEvent {
  detector: string;
  category: string;
  confidence: number;
  action: 'block' | 'warn' | 'sanitize' | 'tripwire';
  input: string;
  detail?: string;
  /** Where the flagged content originated from. */
  provenance: GuardrailProvenance;
}
