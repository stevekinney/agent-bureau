import type { JsonObject } from './serialization/json';

export type ToolRisk = JsonObject & {
  readOnly?: boolean;
  mutates?: boolean;
  dangerous?: boolean;
  permissions?: string[];
  notes?: string[];
};
