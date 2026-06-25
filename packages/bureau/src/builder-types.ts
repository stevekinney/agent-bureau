/**
 * Bureau builder type re-exports.
 *
 * The type-level machinery for the typed fleet builder lives in
 * operative/src/bureau-types.ts. This module re-exports the types that
 * bureau/builder consumers need.
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
export type { AgentRun, RunEvent, RunResult } from 'operative';
