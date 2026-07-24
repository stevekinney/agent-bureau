import type { CostEstimationOptions } from '@lostgradient/operative';
import { estimateCost, getModelPricing } from '@lostgradient/operative';
import { Hono } from 'hono';

import type { Bureau, RunSummary } from '../types';

/**
 * Creates the usage/cost accounting routes (AB-54 usage analytics surface).
 *
 * `GET /usage` — returns aggregated token usage and cost across all runs,
 * grouped by agent, authenticated principal, and time window, plus a
 * per-run breakdown. This is the PTDR (paid ÷ delivered) observability
 * surface from the G2 cancellation work, extended for cost/analytics.
 *
 * The data is driven entirely by the bureau's existing usage-accumulation
 * events: `RunSummary.usage` (accumulated per step from `step.generated`'s
 * `TokenUsage`, including AB-92's `cacheCreationTokens`/`cacheReadTokens`
 * when a provider reports them), `RunSummary.agentName` (resolved at
 * `createRun` time), and `RunSummary.principal` (the authenticated
 * `x-auth-principal` header, threaded through every HTTP run-creation route).
 *
 * Cost is an ESTIMATE only — see `operative`'s `estimateCost` — computed from
 * the bureau's single configured provider model against the default (or
 * caller-supplied) pricing table. `cost` is absent (never fabricated as `0`)
 * on a run/group when no pricing entry exists for the configured model.
 *
 * This is Layer A (live, in-memory) data — `bureau.listRuns()` — mirroring
 * every other RunSummary-backed surface in the gateway. The durable audit
 * trail (Layer B, `bureau.auditTrail`/`GET /api/v1/audit`) already exists for
 * per-event forensics; a durable analytics rollup that survives process
 * restarts is a future addition, not v1's job.
 *
 * Query parameters:
 * - `status` — filter runs by status (matches the existing `listRuns` filter).
 * - `sessionId` — filter to runs belonging to a specific session.
 * - `window` — time-bucket granularity for `analytics.byWindow`: `day`
 *   (default) or `hour`.
 */
export function createUsageRoutes(bureau: Bureau) {
  const app = new Hono();

  app.get('/', (context) => {
    const windowParam = context.req.query('window');
    const response = buildUsageResponse(bureau, {
      status: context.req.query('status'),
      sessionId: context.req.query('sessionId'),
      window: windowParam === 'hour' ? 'hour' : 'day',
    });

    return context.json(response, 200);
  });

  return app;
}

// ── Shared response builder (used by both the JSON route and the SSR /usage page) ──

export interface UsageAggregate {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  runCount: number;
  totalCost: number;
  /** `false` when at least one run had no cost estimate — see {@link UsageGroupTotals.costComplete}. */
  costComplete: boolean;
}

export interface UsageResponse {
  aggregate: UsageAggregate;
  analytics: UsageAnalytics;
  runs: UsageRunView[];
}

/**
 * Builds the full usage/cost analytics payload — the single source of truth
 * consumed by both `GET /api/v1/usage` and the server-rendered `/usage` page
 * (so the two surfaces can never drift).
 */
export function buildUsageResponse(
  bureau: Bureau,
  options: { status?: string; sessionId?: string; window?: TimeWindow } = {},
): UsageResponse {
  const runs = bureau.listRuns(options.status);
  const filtered = options.sessionId ? runs.filter((r) => r.sessionId === options.sessionId) : runs;

  const model = bureau.getConfiguration().provider?.model;
  const views = filtered.map((run) => toRunView(run, model));

  const aggregate = views.reduce<UsageAggregate>(
    (acc, view) => {
      acc.promptTokens += view.usage.promptTokens;
      acc.completionTokens += view.usage.completionTokens;
      acc.totalTokens += view.usage.totalTokens;
      acc.cacheCreationTokens += view.usage.cacheCreationTokens ?? 0;
      acc.cacheReadTokens += view.usage.cacheReadTokens ?? 0;
      acc.runCount += 1;
      if (view.cost) {
        acc.totalCost += view.cost.totalCost;
      } else {
        acc.costComplete = false;
      }
      return acc;
    },
    {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      runCount: 0,
      totalCost: 0,
      costComplete: true,
    },
  );

  const analytics = groupUsage(views, options.window ?? 'day');

  return { aggregate, analytics, runs: views };
}

// ── Grouping (pure, unit-tested directly) ──────────────────────────────

export type TimeWindow = 'hour' | 'day';

/** A single run's usage/cost view, as returned in the `runs` array. */
export interface UsageRunView {
  runId: string;
  sessionId: string;
  status: string;
  agentName: string | undefined;
  principal: string | undefined;
  startedAt: number | undefined;
  steps: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Present only when the run's accumulated usage carried a cache signal (AB-92). */
    cacheCreationTokens?: number;
    /** Present only when the run's accumulated usage carried a cache signal (AB-92). */
    cacheReadTokens?: number;
  };
  /** Absent when the configured model has no pricing entry — never a fabricated `0`. */
  cost?: {
    promptCost: number;
    completionCost: number;
    cacheWriteCost: number;
    cacheReadCost: number;
    totalCost: number;
  };
}

/** Aggregate totals for one bucket of a grouping dimension (agent/principal/window). */
export interface UsageGroupTotals {
  key: string;
  runCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  /**
   * `false` when at least one run in this bucket had no cost estimate (no
   * pricing entry for the model) — `totalCost` is then a floor, not the
   * bucket's true total, and callers should render it as such.
   */
  costComplete: boolean;
}

export interface UsageAnalytics {
  byAgent: UsageGroupTotals[];
  byPrincipal: UsageGroupTotals[];
  byWindow: UsageGroupTotals[];
}

/** Bucket key for a run with no resolved agent (e.g. a recovered run with no tool activity). */
export const UNATTRIBUTED_AGENT = 'unknown';
/** Bucket key for a run with no captured principal (e.g. a scheduler-fired run). */
export const UNATTRIBUTED_PRINCIPAL = 'unattributed';
/** Bucket key for a run with no `startedAt` (should not occur in practice). */
export const UNATTRIBUTED_WINDOW = 'unknown';

/** Formats an epoch-ms timestamp into a UTC time-window bucket key. */
export function windowKey(timestampMs: number, window: TimeWindow): string {
  const iso = new Date(timestampMs).toISOString(); // e.g. "2026-07-09T22:15:48.000Z"
  return window === 'hour' ? `${iso.slice(0, 13)}:00` : iso.slice(0, 10);
}

function toRunView(run: RunSummary, model: string | undefined): UsageRunView {
  const usage = run.usage;
  const pricing: CostEstimationOptions | undefined = undefined;
  const cost =
    model !== undefined && getModelPricing(model, pricing) !== undefined
      ? estimateCost(usage, model, pricing)
      : undefined;

  return {
    runId: run.id,
    sessionId: run.sessionId,
    status: run.status,
    agentName: run.agentName,
    principal: run.principal,
    startedAt: run.startedAt,
    steps: run.steps,
    usage: {
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
      totalTokens: usage.total,
      ...(usage.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: usage.cacheCreationTokens }
        : {}),
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    },
    ...(cost
      ? {
          cost: {
            promptCost: cost.promptCost,
            completionCost: cost.completionCost,
            cacheWriteCost: cost.cacheWriteCost,
            cacheReadCost: cost.cacheReadCost,
            totalCost: cost.totalCost,
          },
        }
      : {}),
  };
}

function emptyGroup(key: string): UsageGroupTotals {
  return {
    key,
    runCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCost: 0,
    costComplete: true,
  };
}

function addRunToGroup(group: UsageGroupTotals, run: UsageRunView): UsageGroupTotals {
  return {
    ...group,
    runCount: group.runCount + 1,
    promptTokens: group.promptTokens + run.usage.promptTokens,
    completionTokens: group.completionTokens + run.usage.completionTokens,
    totalTokens: group.totalTokens + run.usage.totalTokens,
    cacheCreationTokens: group.cacheCreationTokens + (run.usage.cacheCreationTokens ?? 0),
    cacheReadTokens: group.cacheReadTokens + (run.usage.cacheReadTokens ?? 0),
    totalCost: group.totalCost + (run.cost?.totalCost ?? 0),
    costComplete: group.costComplete && run.cost !== undefined,
  };
}

/**
 * Groups a flat list of run usage views by agent, authenticated principal,
 * and time window. Pure function — no I/O, no bureau access — so the
 * required route-level aggregation tests exercise it directly.
 */
export function groupUsage(runs: UsageRunView[], window: TimeWindow = 'day'): UsageAnalytics {
  const byAgent = new Map<string, UsageGroupTotals>();
  const byPrincipal = new Map<string, UsageGroupTotals>();
  const byWindow = new Map<string, UsageGroupTotals>();

  for (const run of runs) {
    const agentKey = run.agentName ?? UNATTRIBUTED_AGENT;
    const principalKey = run.principal ?? UNATTRIBUTED_PRINCIPAL;
    const windowKeyValue =
      run.startedAt !== undefined ? windowKey(run.startedAt, window) : UNATTRIBUTED_WINDOW;

    byAgent.set(agentKey, addRunToGroup(byAgent.get(agentKey) ?? emptyGroup(agentKey), run));
    byPrincipal.set(
      principalKey,
      addRunToGroup(byPrincipal.get(principalKey) ?? emptyGroup(principalKey), run),
    );
    byWindow.set(
      windowKeyValue,
      addRunToGroup(byWindow.get(windowKeyValue) ?? emptyGroup(windowKeyValue), run),
    );
  }

  const sortByKey = (a: UsageGroupTotals, b: UsageGroupTotals): number =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

  return {
    byAgent: [...byAgent.values()].sort(sortByKey),
    byPrincipal: [...byPrincipal.values()].sort(sortByKey),
    byWindow: [...byWindow.values()].sort(sortByKey),
  };
}
