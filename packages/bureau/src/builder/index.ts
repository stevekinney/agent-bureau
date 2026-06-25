/**
 * bureau/builder — the typed fleet builder API.
 *
 * Provides the three-tier typed registry/table:
 *
 * ```ts
 * import { createBureau } from 'bureau/builder';
 *
 * const bureau = createBureau({
 *   agents: { researcher: { instructions: '...' }, writer: {} },
 * });
 *
 * // Tier 2 — chained accretion (return MUST be captured)
 * const bureau2 = bureau.agent({ name: 'editor' });
 *
 * // All three agents are type-safe:
 * const run = bureau2.run('researcher', 'Summarize the Q3 report');
 * for await (const event of run) { ... }
 * const result = await run.result();
 * ```
 */

export { createBureau } from '../builder';
export type {
  AgentBuilder,
  AgentConfig,
  AgentGenerateFunction,
  AgentInput,
  AgentNameFor,
  AgentOptions,
  AgentRun,
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
  RunEvent,
  RunResult,
  SkillPolicy,
  SkillProviderLike,
  ToolEntry,
  ToolEntryInput,
  ToolMap,
  ToolMapInput,
} from '../builder-types';
