/**
 * bureau — the brain.
 *
 * A typed fleet of agents with shared configuration, durable orchestration,
 * memory, and scheduling. Transport-agnostic: `gateway(bureau)` wraps it in
 * HTTP/WebSocket; in-process consumers call `bureau.run('name', input)` directly.
 *
 * Typical usage:
 *
 * ```ts
 * import { createBureau } from 'bureau';
 *
 * const bureau = createBureau({
 *   agents: {
 *     researcher: { instructions: 'You are a research assistant.' },
 *     writer:     {},
 *   },
 * });
 *
 * // Tier 2 — chained accretion (return MUST be captured)
 * const bureau2 = bureau.agent({ name: 'editor' });
 *
 * // All three agents are now type-safe:
 * const run = bureau2.run('researcher', 'Summarize the Q3 report');
 * for await (const event of run) { ... }
 * const result = await run.result();
 * ```
 */

export { createBureau } from './create-bureau';
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
} from './types';
