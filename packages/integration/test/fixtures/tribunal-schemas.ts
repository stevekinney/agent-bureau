/**
 * AB-99 — a literal copy of the Zod validators Tribunal's runner result must
 * satisfy, taken from `/Users/stevekinney/Developer/tribunal/packages/review-core/src/schemas.ts`
 * (`effortSchema`, `findingSchema`, `triageDecisionSchema`,
 * `verificationDecisionSchema`, `agentResultSchema`), plus the raw JSON
 * Schema per-role output contracts copied from
 * `tribunal/runner/run-agent.mjs`'s `outputSchemaForRole`.
 *
 * This is intentionally a COPY, not an import — `@tribunal/review-core` is
 * not a dependency of this monorepo and must not become one (agent-bureau
 * does not consume Tribunal; Tribunal is migrating TO agent-bureau, see
 * `docs/tribunal-migration-map.md`). The copy is what the conformance
 * harness's terminal envelope is asserted against: proof that mapping an
 * agent-bureau `RunReport` into Tribunal's `agentResult` shape produces
 * something Tribunal's own validator accepts.
 */
import type { RunReport } from '@lostgradient/operative';
import { z } from 'zod';

export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const findingSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
  side: z.enum(['LEFT', 'RIGHT']),
  severity: z.enum(['info', 'warning', 'error']),
  title: z.string().min(1),
  body: z.string().min(1),
  suggestion: z.string().optional(),
  mergedFingerprints: z.array(z.string()).optional(),
});

export const triageDecisionSchema = z.object({
  skip: z.boolean(),
  reason: z.string(),
  riskFlags: z.array(z.string()),
});

export const verificationDecisionSchema = z.object({
  verified: z.boolean(),
  note: z.string(),
});

export const agentResultSchema = z.object({
  agentSlug: z.string().min(1),
  findings: z.array(findingSchema),
  modelUsed: z.string().min(1),
  effortUsed: effortSchema.nullable(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
  }),
  costEstimateUsd: z.number().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  stopped: z.enum(['superseded', 'pr_closed', 'budget', 'timeout']).optional(),
  error: z.string().optional(),
  triage: triageDecisionSchema.optional(),
  verification: verificationDecisionSchema.optional(),
});

export type AgentRunRole = 'triage' | 'specialist' | 'verifier';

/**
 * Raw JSON Schema (AB-95) per-role output contracts — copied verbatim from
 * `run-agent.mjs`'s `outputSchemaForRole(role)`. Passed straight through as
 * `RunOptions.responseSchema` (a "raw JSON Schema object" per the matrix in
 * `@lostgradient/operative/structured-output/response-schema.ts`).
 */
export function tribunalOutputSchemaForRole(role: AgentRunRole): Record<string, unknown> {
  if (role === 'triage') {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['skip', 'reason', 'riskFlags'],
      properties: {
        skip: { type: 'boolean' },
        reason: { type: 'string' },
        riskFlags: { type: 'array', items: { type: 'string' } },
      },
    };
  }
  if (role === 'verifier') {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['verified', 'note'],
      properties: {
        verified: { type: 'boolean' },
        note: { type: 'string' },
      },
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'startLine', 'endLine', 'side', 'severity', 'title', 'body'],
          properties: {
            path: { type: 'string' },
            startLine: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
            endLine: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
            side: { enum: ['LEFT', 'RIGHT'] },
            severity: { enum: ['info', 'warning', 'error'] },
            title: { type: 'string' },
            body: { type: 'string' },
            suggestion: { type: 'string' },
          },
        },
      },
    },
  };
}

export interface FindingLike {
  path: string;
  startLine: number | null;
  endLine: number | null;
  side: 'LEFT' | 'RIGHT';
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  suggestion?: string | undefined;
}

/**
 * Maps an agent-bureau `RunReport` (AB-96) into Tribunal's `agentResult`
 * shape — the same normalization `run-agent.mjs`'s `createResult()` does
 * from an SDK `result` message, but from bureau's envelope instead. The
 * mapping is deliberately narrow: it reads only the fields Tribunal's
 * `agentResultSchema` cares about, exactly mirroring
 * `run-agent.mjs`'s `normalizeUsage`/`createResult` field-by-field.
 */
export function mapRunReportToTribunalAgentResult(
  report: RunReport,
  context: { agentSlug: string; findings: FindingLike[]; costEstimateUsd?: number },
): unknown {
  const structured =
    report.structuredOutput && typeof report.structuredOutput === 'object'
      ? (report.structuredOutput as Record<string, unknown>)
      : undefined;

  return {
    agentSlug: context.agentSlug,
    findings: context.findings,
    modelUsed: report.effectiveModel ?? 'unknown',
    // AB-91's provider adapters set `metadata.effectiveEffort` to the
    // literal string `'none'` (not `undefined`) whenever no effort option
    // was supplied — see `createAnthropicProvider`/`createOpenAIProvider`'s
    // `effectiveEffort: resolvedEffort ?? 'none'`. Tribunal's `effortSchema`
    // only accepts the real effort enum or `null`, so that sentinel must be
    // normalized here rather than passed through.
    effortUsed:
      report.effectiveEffort && report.effectiveEffort !== 'none' ? report.effectiveEffort : null,
    usage: {
      inputTokens: report.usage.prompt,
      outputTokens: report.usage.completion,
      cacheReadTokens: report.usage.cacheReadTokens ?? 0,
      cacheCreationTokens: report.usage.cacheCreationTokens ?? 0,
    },
    costEstimateUsd: context.costEstimateUsd ?? report.costEstimate?.totalCost ?? 0,
    durationMs: 0,
    ...(report.status === 'aborted' ? { stopped: 'timeout' as const } : {}),
    ...(report.status === 'budget_stopped' ? { stopped: 'budget' as const } : {}),
    ...(report.error ? { error: report.error } : {}),
    ...(structured && Array.isArray(structured['riskFlags'])
      ? {
          triage: {
            skip: structured['skip'] === true,
            reason: typeof structured['reason'] === 'string' ? structured['reason'] : '',
            riskFlags: structured['riskFlags'],
          },
        }
      : {}),
    ...(structured && typeof structured['verified'] === 'boolean'
      ? {
          verification: {
            verified: structured['verified'],
            note: typeof structured['note'] === 'string' ? structured['note'] : '',
          },
        }
      : {}),
  };
}
