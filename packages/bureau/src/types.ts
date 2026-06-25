/**
 * Bureau type re-exports.
 *
 * The type-level machinery for the bureau/agent/run architecture lives in
 * operative/src/bureau-types.ts (proven by the Phase A4 type spike). This
 * module re-exports the types that bureau consumers need, keeping the import
 * surface clean: `import type { BureauBuilder } from 'bureau'`.
 *
 * Dependency direction: bureau → operative (never the reverse).
 */

export type {
  AgentBuilder,
  AgentConfig,
  AgentGenerateFunction,
  AgentInput,
  AgentNameFor,
  AgentOptions,
  AgentTable,
  AgentToolNames,
  AgentTools,
  BureauAgentsInput,
  BureauBuilder,
  BureauToolNames,
  BureauTools,
  CreateAgentOptions,
  NormalizeAgents,
  NormalizeTools,
  SkillPolicy,
  SkillProviderLike,
  ToolEntry,
  ToolEntryInput,
  ToolMap,
  ToolMapInput,
} from 'operative/bureau-types';

// Re-export operative's run types for bureau consumers who iterate runs.
export type { AgentRun, RunEvent } from 'operative';
export type { RunResult } from 'operative';
