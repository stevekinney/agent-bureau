import type {
  DetectorContext,
  GuardrailProvenance,
  GuardrailTriggeredEvent,
  InputDetector,
} from 'armorer';
import { scanContent } from 'armorer';

import { SOURCE_DOCUMENT_KEY } from './ingest';
import type { MemoryMetadata } from './types';

/**
 * Options for scanning recalled/ingested content through the shared
 * `armorer` guardrail detector pipeline before it enters the model's
 * context. This is the same pipeline (and built-in detectors) operative's
 * input guardrail runs against user messages — reused here for retrieved
 * content rather than duplicated.
 */
export interface MemoryGuardrailOptions {
  /** Detectors to run against recalled content. */
  detectors: InputDetector[];
  /**
   * `'block'` (default) drops a flagged entry from the returned/injected
   * results entirely. `'warn'` keeps the entry but marks it `flagged: true`
   * and still fires `onTriggered`.
   */
  action?: 'block' | 'warn';
  /** Run detectors in parallel (default) or sequentially. */
  mode?: 'parallel' | 'sequential';
  /** Called when a detector trips on a recalled/ingested entry. */
  onTriggered?: (event: GuardrailTriggeredEvent) => void;
  /** Getter that returns the current session taint state, if tracked externally. */
  getSessionTainted?: () => boolean;
}

/**
 * Determines whether a memory entry's content originated from `ingest()`
 * (an ingested document, tagged with `__sourceDocument`) or a directly
 * remembered entry (recalled memory) — distinct provenance for taint
 * tracking even though both flow through the same recall path.
 */
export function provenanceForMemoryEntry(metadata: MemoryMetadata): GuardrailProvenance {
  return metadata[SOURCE_DOCUMENT_KEY] !== undefined ? 'ingested-document' : 'recalled-memory';
}

/** Result of scanning a single memory entry's content. */
export interface ScannedMemoryContent {
  content: string;
  blocked: boolean;
  flagged: boolean;
  event?: GuardrailTriggeredEvent;
}

/**
 * Runs a memory entry's content through the shared detector pipeline,
 * tagging the `DetectorContext` with the entry's provenance (recalled memory
 * vs. ingested document — distinct from `'user-input'`).
 */
export async function scanMemoryContent(
  content: string,
  metadata: MemoryMetadata,
  options: MemoryGuardrailOptions,
): Promise<ScannedMemoryContent> {
  const provenance = provenanceForMemoryEntry(metadata);
  const context: DetectorContext = {
    step: 0,
    conversationLength: 0,
    sessionTainted: options.getSessionTainted?.() ?? false,
    provenance,
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
