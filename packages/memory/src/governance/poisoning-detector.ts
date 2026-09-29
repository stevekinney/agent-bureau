import type { DetectionResult, InputDetector } from 'armorer';

/**
 * Rules for content that tries to act as an instruction or an authority grant
 * rather than as a remembered fact: instruction overrides, role and delimiter
 * spoofing, claims that the model holds or should grant authority, requests to
 * skip approval or sandbox controls, and pipe-to-shell procedures. Unlike the
 * general prompt-injection detector it does not treat markdown headings or
 * ordinary "act as" phrasing as suspicious, because assistant output persisted
 * as memory routinely contains both.
 */
const POISONING_RULES: readonly RegExp[] = [
  /\b(?:ignore|disregard|override|forget)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions|directives|rules|prompts?|polic(?:y|ies))\b/i,
  /\bnew\s+(?:system\s+)?instructions\s*:/i,
  /\byou\s+are\s+now\b/i,
  /\[(?:SYSTEM|INST)\]/i,
  /<\|(?:system|im_start)\|>/i,
  /\b(?:system\s+prompt|developer\s+message)\s*:/i,
  /\b(?:grant|give)\s+(?:yourself|the\s+(?:agent|assistant|model))\b[^.\n]*\b(?:permission|access|authority|capabilit(?:y|ies))\b/i,
  /\b(?:always|automatically)\s+(?:approve|authori[sz]e|execute|run)\b/i,
  /\b(?:bypass|disable|skip)\s+(?:the\s+)?(?:approval|sandbox|guardrails?|polic(?:y|ies)|confirmation|review)\b/i,
  /\bcurl\s+[^\n|]*\|\s*(?:ba|z)?sh\b/i,
];

function confidenceFor(matches: number): number {
  if (matches >= 3) return 0.9;
  return matches === 2 ? 0.75 : 0.5;
}

/**
 * The default admission and recall detector for governed memory. The result's
 * `detail` names only how many rules matched, never the matched text, so the
 * diagnostic can be recorded without copying restricted content.
 */
export function createMemoryPoisoningDetector(): InputDetector {
  return {
    name: 'memory-poisoning',
    detect(input: string): Promise<DetectionResult> {
      const matches = POISONING_RULES.filter((rule) => rule.test(input)).length;
      if (matches === 0) {
        return Promise.resolve({ triggered: false, confidence: 0, category: 'memory-poisoning' });
      }
      return Promise.resolve({
        triggered: true,
        confidence: confidenceFor(matches),
        category: 'memory-poisoning',
        detail: `Matched ${matches} memory-poisoning rule(s)`,
      });
    },
  };
}
