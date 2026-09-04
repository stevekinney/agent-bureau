import type { CleanupAcknowledgement } from '@lostgradient/operative';
import type { LivenessSnapshot } from '@lostgradient/operative/liveness';
import { LIVENESS_POLICY_VERSION } from '@lostgradient/operative/liveness';
import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { resolvePrincipal, resolveTrustedRequestContext } from '../middleware/authentication';
import { assembleRunTimeline } from '../timeline';
import type { Bureau, CreateRunRequest, PendingReview, RunDetail } from '../types';
import { respondWithEventHistoryPage } from './event-history';

export { assembleRunTimeline, type RunTimelineEntry, type RunTimelineEntryKind } from '../timeline';

// ── Request-disconnect propagation (AB-212) ─────────────────────────────
//
// AB-37's decision record rules two disconnect policies: an ATTACHED run
// (a process-local run this request's own `AbortSignal` was forwarded into)
// is aborted when the client disconnects, its cleanup awaited via
// `closed()`; a DETACHED run (durable, or one no signal was forwarded to)
// keeps running — only the gateway's own connection-level bookkeeping (the
// SSE/WebSocket subscriber, `live-events.ts`) is torn down. This module owns
// the classification rule and the attached-branch disconnect handler; the
// detached branch's behavior already lives in `live-events.ts` (SSE/WebSocket
// disconnects have never touched a run) and needs no new production code.

export type RunAttachment = 'attached' | 'detached';

/**
 * The single rule AB-212's AC1 names: a run is `'attached'` to the request
 * that started it only when BOTH the route forwarded that request's
 * `AbortSignal` into the run AND the run's resolved durability is
 * `'process-local'`. A durable run is always `'detached'` even when a
 * signal was forwarded — AB-37 rules durable work must survive the request
 * that started it, so this classification is what lets the disconnect
 * handler below decide never to touch it.
 */
export function classifyRunAttachment(input: {
  signalForwarded: boolean;
  durability: LivenessSnapshot['durability'];
}): RunAttachment {
  return input.signalForwarded && input.durability === 'process-local' ? 'attached' : 'detached';
}

/**
 * The attached-branch disconnect handler (AB-212's AC2): aborts `runId`'s
 * live `ActiveRun`, awaits its `closed()` cleanup acknowledgement (AB-204 —
 * never rejects), and records the outcome to the durable audit trail as a
 * `run.disconnect-aborted` entry. A no-op if the run is no longer registered
 * in the process-local store (already deleted), if this bureau has no audit
 * trail composed (ephemeral bureau — the abort/closed cleanup still runs;
 * only the durable write is skipped), or if the run has already reached a
 * terminal status by the time this fires (a fast run that finished before a
 * later disconnect arrived) — `ActiveRun.abort()` on an already-terminal run
 * is a documented idempotent no-op, but calling it here would still write a
 * misleading `run.disconnect-aborted` entry against a run this disconnect
 * never actually affected (Copilot review).
 */
async function abortAttachedRunOnDisconnect(bureau: Bureau, runId: string): Promise<void> {
  const runState = bureau.store.getRun(runId);
  if (!runState || runState.status !== 'running') return;

  runState.activeRun.abort('Client disconnected from the request that started this run');
  const acknowledgement: CleanupAcknowledgement = await runState.activeRun.closed();

  await bureau.auditTrail?.record({
    runId,
    type: 'run.disconnect-aborted',
    detail: { acknowledgement },
  });
}

/**
 * Registers the disconnect propagation for an attached run: if `signal` is
 * already aborted (the client vanished while `bureau.createRun` was still
 * doing its own async setup), the handler fires immediately; otherwise it
 * fires the first time `signal` aborts, and DETACHES that listener once the
 * run itself settles — matching `create-run.ts`'s own signal-listener
 * lifecycle — so a disconnect arriving after the run already finished on its
 * own never fires this handler at all (Copilot review; the `status !==
 * 'running'` guard in {@link abortAttachedRunOnDisconnect} above is a second,
 * independent layer against the same race). A no-op if `runId` is not (or is
 * no longer) registered in the process-local store. Exported for direct
 * reuse by any other route that starts an inline (process-local) run and
 * awaits it synchronously — the openai-compat non-streaming path is the
 * other site AB-37's "synchronous HTTP call awaiting a run" row describes.
 */
export function propagateDisconnectToAttachedRun(
  bureau: Bureau,
  runId: string,
  signal: AbortSignal,
): void {
  const runState = bureau.store.getRun(runId);
  if (!runState) return;

  if (signal.aborted) {
    void abortAttachedRunOnDisconnect(bureau, runId);
    return;
  }

  const onAbort = (): void => {
    void abortAttachedRunOnDisconnect(bureau, runId);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  void runState.activeRun.result.finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

function publicCreateRunRequest(
  body: CreateRunRequest,
): Omit<CreateRunRequest, 'principal' | 'requestContext'> {
  const request: Omit<CreateRunRequest, 'principal' | 'requestContext'> = { message: body.message };
  if (body.sessionId !== undefined) request.sessionId = body.sessionId;
  if (body.systemPrompt !== undefined) request.systemPrompt = body.systemPrompt;
  if (body.maximumSteps !== undefined) request.maximumSteps = body.maximumSteps;
  if (body.maximumTokens !== undefined) request.maximumTokens = body.maximumTokens;
  if (body.agentName !== undefined) request.agentName = body.agentName;
  return request;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createRunsRoutes(bureau: Bureau) {
  const app = new Hono();

  app.post('/', async (context) => {
    let body: unknown;
    try {
      body = await context.req.json<unknown>();
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }
    if (!isJsonObject(body)) {
      throw new HTTPException(400, { message: 'Run request body must be a JSON object' });
    }
    try {
      if (
        'agentName' in body &&
        body['agentName'] !== undefined &&
        typeof body['agentName'] !== 'string'
      ) {
        throw new HTTPException(400, { message: 'agentName must be a string' });
      }
      // Overwrite any caller-supplied `principal` with the authenticated
      // principal from the verified request header — never trust it from an
      // untrusted request body (AB-54 usage analytics attribution).
      const request = publicCreateRunRequest(body as unknown as CreateRunRequest);
      const requestContext = resolveTrustedRequestContext(context, request.agentName);
      // Captured BEFORE `createRun` so a disconnect during its own async
      // setup (session load, durable dispatch) is observable below — the
      // signal on `context.req.raw` is this HTTP request's own, independent
      // of how long `createRun` takes to resolve.
      const requestSignal = context.req.raw.signal;
      const summary = await bureau.createRun({
        ...request,
        principal: resolvePrincipal(context),
        ...(requestContext ? { requestContext } : {}),
      });

      // AB-212 — classify this run's attachment to the request that started
      // it and, if attached, propagate a future disconnect. `durability`
      // defaults to `'process-local'` only for the vanishingly unlikely case
      // where the run has already been removed from the store by the time we
      // look it up (a race with immediate deletion) — the safer default is
      // to treat it as eligible for the attached-run cleanup, not to skip it.
      const durability = bureau.getRun(summary.id)?.liveness.durability ?? 'process-local';
      const attachment = classifyRunAttachment({ signalForwarded: true, durability });
      if (attachment === 'attached') {
        propagateDisconnectToAttachedRun(bureau, summary.id, requestSignal);
      }

      return context.json(summary, 201);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_CONFIGURED')
          throw new HTTPException(503, { message: error.message });
        if (error.code === 'BAD_REQUEST') throw new HTTPException(400, { message: error.message });
        if (error.code === 'CONFLICT') throw new HTTPException(409, { message: error.message });
        // AB-13 — a flow-control policy (concurrency cap, rate limit, or
        // singleton dedupe) rejected this run's admission.
        if (error.code === 'RATE_LIMITED') throw new HTTPException(429, { message: error.message });
      }
      throw error;
    }
  });

  app.get('/', (context) => {
    const status = context.req.query('status');
    return context.json(bureau.listRuns(status), 200);
  });

  app.get('/:id', (context) => {
    const detail = buildRunDetailResponse(bureau, context.req.param('id'));
    if (!detail) throw new HTTPException(404, { message: 'Run not found' });
    return context.json(detail, 200);
  });

  // AB-312 — durable event history paging for this run.
  app.get('/:id/events', (context) =>
    respondWithEventHistoryPage(context, bureau, { kind: 'run', id: context.req.param('id') }),
  );

  app.post('/:id/abort', (context) => {
    try {
      const run = bureau.abortRun(context.req.param('id'));
      return context.json(run, 200);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_FOUND') throw new HTTPException(404, { message: error.message });
        if (error.code === 'CONFLICT') throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  app.delete('/:id', async (context) => {
    try {
      await bureau.deleteRun(context.req.param('id'));
      return context.body(null, 204);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_FOUND') throw new HTTPException(404, { message: error.message });
        if (error.code === 'CONFLICT') throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  return app;
}

// ── Shared response builder (used by both the JSON route and the SSR /runs/:id page) ──

export interface RunDetailResponse extends RunDetail {
  timeline: ReturnType<typeof assembleRunTimeline>;
}

/**
 * A placeholder `LivenessSnapshot` (AB-88/AB-214) for UI/test fixtures that
 * need a legal, structurally-complete value before a real run exists — never
 * served over the wire (the JSON route always carries `bureau.getRun`'s own
 * `liveness` field).
 */
export const EMPTY_LIVENESS_SNAPSHOT: LivenessSnapshot = {
  id: '',
  kind: 'agent-run',
  startedAt: new Date(0).toISOString(),
  revision: 0,
  status: 'created',
  lastTransitionAt: new Date(0).toISOString(),
  projection: 'redacted',
  ownership: 'independent',
  detached: false,
  durability: 'process-local',
  cancellable: true,
  attempt: 0,
  reachability: 'unknown',
  progress: 'unknown',
  assessment: 'healthy',
  observedAt: 0,
  missedPulseCount: 0,
  policyVersion: LIVENESS_POLICY_VERSION,
  evidence: [],
};

/**
 * Finds the pending human-wait review (if any) parking `runId` — the resume
 * affordance the run-detail view offers a parked run, reusing AB-20's review
 * queue plumbing (`Bureau.listPendingReviews`/`resolveReview`) rather than
 * inventing a second resume path. `undefined` when the run is not currently
 * parked on a human-wait signal (including tool-approval parks, which have
 * no `runId`-scoped signal to resume via this affordance).
 */
export function findParkedReview(
  reviews: readonly PendingReview[],
  runId: string,
): PendingReview | undefined {
  return reviews.find((review) => review.kind === 'human-wait' && review.runId === runId);
}

/**
 * Builds the full run-detail response — the run record plus its assembled
 * timeline — shared by `GET /api/v1/runs/:id` and the SSR `/runs/:id` page
 * (`server/pages.ts`) so both surfaces agree on shape. `undefined` when the
 * run does not exist.
 */
export function buildRunDetailResponse(bureau: Bureau, id: string): RunDetailResponse | undefined {
  const run = bureau.getRun(id);
  if (!run) return undefined;
  return { ...run, timeline: assembleRunTimeline(run.events) };
}
