import type { ContextSourceRecord, EffectiveContextEpoch } from '../context-epoch';
import { digestText } from '../context-epoch';
import { PII_RULES } from '../guardrails/validators/output-pii';
import { SENSITIVE_KEY_PATTERN } from '../run-envelope';
import type { FreshAttemptRejectionDiagnostic } from './errors';
import { formatFieldPath } from './field-path';
import type { FreshAttemptHandoffArtifact } from './handoff-artifact';
import {
  FRESH_ATTEMPT_ARTIFACT_ENTROPY_MINIMUM_TOKEN_LENGTH,
  FRESH_ATTEMPT_ARTIFACT_ENTROPY_THRESHOLD,
} from './thresholds';

/**
 * COR-1354 — the four secret-bearing legs COR-894 and its owner ruling name.
 * Each returns a field path and a rule, never the value that matched.
 *
 * 1. Structural: transcript-shaped values (a `role` key, a raw tool payload,
 *    a `ConversationHistory`), as objects or serialized into a string.
 * 2. Pattern: `SENSITIVE_KEY_PATTERN` and `PII_RULES.apiKey`, both reused
 *    from where the runtime already applies them.
 * 3. Epoch digest: a string that reproduces, verbatim, a `protected-secret`
 *    or `forbidden` source of the producing run's sealed epoch.
 * 4. Entropy: a bare high-entropy token with no key prefix.
 */

const TOOL_PAYLOAD_KEYS = new Set([
  'toolCall',
  'toolCalls',
  'toolResult',
  'tool_calls',
  'tool_call_id',
  'tool_use_id',
  'functionCall',
  'functionResponse',
]);

const SERIALIZED_ROLE_PATTERN =
  /["']role["']\s*:\s*["'](?:system|developer|user|assistant|tool|model)["']/i;

const SERIALIZED_TOOL_PAYLOAD_PATTERN =
  /["'](?:toolCalls?|toolResult|tool_calls|tool_call_id|tool_use_id|functionCall|functionResponse)["']\s*:|["']type["']\s*:\s*["'](?:tool_use|tool_result|function_call)["']/;

/**
 * `SENSITIVE_KEY_PATTERN` is a key-name test. Inside prose it is applied to
 * the key of each `key: value` or `key=value` pair, which is the shape a
 * pasted credential takes, rather than to every word: an artifact about this
 * runtime legitimately says "token budget" or "authorization check".
 */
const KEY_VALUE_PATTERN = /([A-Za-z0-9_.-]+)["']?\s*[:=]\s*\S/g;

const ENTROPY_TOKEN_PATTERN = new RegExp(
  `[A-Za-z0-9+/=_-]{${FRESH_ATTEMPT_ARTIFACT_ENTROPY_MINIMUM_TOKEN_LENGTH},}`,
  'g',
);

/** A source whose content may never leave its epoch in any form a fresh attempt can read. */
export function isProtectedContextSource(source: ContextSourceRecord): boolean {
  return source.trust === 'protected-secret' || source.redaction === 'forbidden';
}

function transcriptRuleForObject(record: object): string | undefined {
  const keys = Object.keys(record);
  if (keys.includes('role')) return 'transcript-role-key';
  if (keys.some((key) => TOOL_PAYLOAD_KEYS.has(key))) return 'transcript-tool-payload';
  if (keys.includes('ids') && keys.includes('messages')) return 'conversation-history-shape';
  return undefined;
}

function transcriptRuleForString(text: string): string | undefined {
  if (SERIALIZED_ROLE_PATTERN.test(text)) return 'transcript-role-key';
  if (SERIALIZED_TOOL_PAYLOAD_PATTERN.test(text)) return 'transcript-tool-payload';
  return undefined;
}

/**
 * Structural leg. Walks the raw, not-yet-validated value, so a `Message`
 * smuggled where a string belongs is reported as secret-bearing (a policy
 * violation) rather than merely as a schema mismatch. Cycle-safe.
 */
export function findTranscriptShape(
  value: unknown,
  path: readonly PropertyKey[] = [],
  seen: WeakSet<object> = new WeakSet(),
): FreshAttemptRejectionDiagnostic | undefined {
  if (typeof value === 'string') {
    const rule = transcriptRuleForString(value);
    return rule === undefined ? undefined : { path: formatFieldPath(path), rule };
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return undefined;
  seen.add(value);
  const rule = Array.isArray(value) ? undefined : transcriptRuleForObject(value);
  if (rule !== undefined) return { path: formatFieldPath(path), rule };
  const entries: [PropertyKey, unknown][] = Array.isArray(value)
    ? value.map((entry: unknown, index) => [index, entry])
    : Object.entries(value);
  for (const [key, entry] of entries) {
    const found = findTranscriptShape(entry, [...path, key], seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Every string leaf of a validated artifact, with its field path. */
export function collectStringFields(
  value: unknown,
  path: readonly PropertyKey[] = [],
): { readonly path: string; readonly value: string }[] {
  if (typeof value === 'string') return [{ path: formatFieldPath(path), value }];
  if (Array.isArray(value)) {
    return value.flatMap((entry: unknown, index) => collectStringFields(entry, [...path, index]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      collectStringFields(entry, [...path, key]),
    );
  }
  return [];
}

function patternRule(text: string): string | undefined {
  for (const match of text.matchAll(KEY_VALUE_PATTERN)) {
    if (SENSITIVE_KEY_PATTERN.test(match[1] ?? '')) return 'sensitive-key-pattern';
  }
  const apiKey = PII_RULES.apiKey.regex;
  apiKey.lastIndex = 0;
  return apiKey.test(text) ? 'pii-api-key' : undefined;
}

/** Shannon entropy of `token`, in bits per character. */
export function shannonEntropy(token: string): number {
  const counts = new Map<string, number>();
  for (const character of token) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / token.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/** The highest entropy of any token in `text` the entropy leg measures; 0 when none qualifies. */
export function highestTokenEntropy(text: string): number {
  let highest = 0;
  for (const [token] of text.matchAll(ENTROPY_TOKEN_PATTERN)) {
    highest = Math.max(highest, shannonEntropy(token));
  }
  return highest;
}

/**
 * Pattern, epoch-digest, and entropy legs over every string field of a
 * schema-valid artifact. Returns one diagnostic per offending field.
 */
export function findSecretBearingFields(
  artifact: FreshAttemptHandoffArtifact,
  epoch: EffectiveContextEpoch,
): FreshAttemptRejectionDiagnostic[] {
  const protectedDigests = new Set(
    epoch.sources.flatMap((source) =>
      isProtectedContextSource(source) && source.digest !== undefined ? [source.digest] : [],
    ),
  );
  return collectStringFields(artifact).flatMap((field) => {
    const rule =
      patternRule(field.value) ??
      (protectedDigests.has(digestText(field.value)) ? 'protected-source-digest' : undefined) ??
      (highestTokenEntropy(field.value) > FRESH_ATTEMPT_ARTIFACT_ENTROPY_THRESHOLD
        ? 'high-entropy-token'
        : undefined);
    return rule === undefined ? [] : [{ path: field.path, rule }];
  });
}
