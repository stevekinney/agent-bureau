import type { DurableRunDeps, RunCursor } from './types';

/** Input to the durable agent-run workflow. */
export interface AgentRunWorkflowInput {
  runId: string;
  /**
   * The bureau session that owns this run. Carried in the durable input (not a
   * side table) so boot recovery can correlate a recovered `WorkflowHandle` back
   * to its session — the resolver reads it as `info.input.sessionId` and
   * `recoverDurableRuns` reads it via `handle.getLaunchMetadata()` — without
   * scanning the session store by `lastRunId`. A plain cloneable string, safe to
   * checkpoint.
   */
  sessionId: string;
  /**
   * The name of the agent that owns this run (F2 — RunRef.agentName).
   *
   * Carried in the durable input (not a side table) so a recovered workflow can
   * be correlated to its owning agent without reading the session store. A session
   * may be worked by a SEQUENCE of different agents over time (via handoff);
   * agentName on each workflow uniquely identifies which agent ran each run.
   */
  agentName: string;
  /** The first user message to seed a brand-new run (ignored on resume). */
  prompt?: string | undefined;
  /** Safety bound on step count, mirroring `RunOptions.maximumSteps`. */
  maximumSteps?: number | undefined;
}

/**
 * Narrow an `unknown` durable input (as Weft surfaces it via
 * `resolveWorkflowServices`'s `info.input` and `WorkflowHandle.getLaunchMetadata`)
 * to an {@link AgentRunWorkflowInput}. A type guard, not an `as` cast: the input
 * crosses the checkpoint as plain JSON, so its shape must be validated at the
 * trust boundary. Requires the three correlation fields recovery depends on
 * (`runId`, `sessionId`, `agentName`); a run checkpointed before `agentName` was
 * added to the input fails this guard and is treated as not-reconstructable (no
 * compatibility-bridge fallback — cross-upgrade in-flight runs are out of scope).
 */
export function isAgentRunWorkflowInput(value: unknown): value is AgentRunWorkflowInput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['runId'] !== 'string' ||
    typeof candidate['sessionId'] !== 'string' ||
    typeof candidate['agentName'] !== 'string'
  ) {
    return false;
  }
  // Validate the optional fields too, so a narrowed value is sound end-to-end
  // (not just for the three correlation fields recovery keys on).
  const prompt = candidate['prompt'];
  if (prompt !== undefined && typeof prompt !== 'string') return false;
  const maximumSteps = candidate['maximumSteps'];
  if (maximumSteps !== undefined && typeof maximumSteps !== 'number') return false;
  return true;
}

/** Options for {@link createRunWorkflow}. */
export interface CreateRunWorkflowOptions {
  /**
   * The workflow version identifier stamped into every new run's cursor at
   * creation (AB-10 — workflow versioning for in-flight durable runs). Pass
   * the same value to {@link import('./create-run-engine').CreateRunEngineOptions.runWorkflowVersion}
   * so recovery can compare a resumed run's stamped version against the
   * currently-registered one and surface a mismatch via
   * `onWorkflowVersionMismatch` — see that option's JSDoc for why this is a
   * SEPARATE, softer mechanism from Weft's own `workflow({ version })`
   * recovery check (which throws and aborts the WHOLE fleet's `recoverAll()`
   * on a single mismatched run; not used here). Omit to disable stamping —
   * every run's `workflowVersion` is then `undefined` and no mismatch is ever
   * reported.
   */
  version?: string | undefined;
}
/** Build the cloneable cursor for a new workflow run. */
export function initialCursor(
  version: string | undefined,
  initialAppliedConfigVersion = 0,
): RunCursor {
  return {
    step: 0,
    totalUsage: { prompt: 0, completion: 0, total: 0 },
    lastContent: '',
    schemaAttempts: 0,
    lastAppliedConfigVersion: initialAppliedConfigVersion,
    ...(version !== undefined ? { workflowVersion: version } : {}),
  };
}

/** Resolve the live workflow dependencies inside a no-yield region. */
export function runDepsFrom(services: unknown): DurableRunDeps {
  return services as DurableRunDeps;
}
