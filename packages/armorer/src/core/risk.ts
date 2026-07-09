import type { JsonObject } from './serialization/json';

export type ToolRisk = JsonObject & {
  readOnly?: boolean;
  mutates?: boolean;
  dangerous?: boolean;
  untrustedOutput?: boolean;
  permissions?: string[];
  notes?: string[];
};

export function buildTagsFromRisk(baseTags: readonly string[], risk: ToolRisk | undefined) {
  const merged = new Set(baseTags);
  if (risk?.mutates === true) {
    merged.add('mutating');
  }
  if (risk?.readOnly === true) {
    merged.add('readonly');
  }
  if (risk?.dangerous === true) {
    merged.add('dangerous');
  }
  if (risk?.untrustedOutput === true) {
    merged.add('untrusted-output');
  }
  return Array.from(merged);
}
