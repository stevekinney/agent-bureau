import { listEvaluationReports } from 'evaluation';
import { Hono } from 'hono';

import { createScopeGuard } from '../middleware/scope-guard';
import { buildRunDetailResponse, type RunDetailResponse } from '../routes/runs';
import { buildUsageResponse, type UsageResponse } from '../routes/usage';
import type {
  Bureau,
  ConfigurationResponse,
  EvaluationReportsResponse,
  PendingReview,
  ProviderConfiguration,
  RunSummary,
} from '../types';
import { SCOPE } from '../types';
import App from '../ui/app.svelte';
import { renderPage } from './render';

/**
 * The canonical per-route hydration payload. Mirrors the client app's
 * `InitialData` contract: only `runs`, `run`, `config`, `reviews`, and
 * `evaluations` are ever populated, each on the route that owns it.
 */
interface InitialData {
  runs?: RunSummary[];
  run?: RunDetailResponse;
  config?: ConfigurationResponse;
  reviews?: PendingReview[];
  usage?: UsageResponse;
  evaluations?: EvaluationReportsResponse;
}

interface PageDependencies {
  bureau: Bureau;
  /**
   * Redacted provider configuration, accepted for call-site compatibility
   * with `create-gateway`. The authoritative configuration the
   * configuration page consumes is read from {@link Bureau.getConfiguration}
   * — which already carries `provider`, `providers`, `maximumSteps`,
   * `systemPrompt`, and `tools` — so these fields are not re-derived here.
   */
  provider: Omit<ProviderConfiguration, 'apiKey'> | undefined;
  maximumSteps: number;
  systemPrompt: string | undefined;
  /**
   * Directory of evaluation report JSON files backing the `/evaluations`
   * page (mirrors `GatewayOptions.evaluationReportsDirectory`). Undefined
   * means the page renders empty — evaluation reporting is opt-in.
   */
  evaluationReportsDirectory: string | undefined;
}

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' } as const;

/**
 * Renders the Svelte {@link App} for a route into the HTML shell and wraps
 * it in an HTML `Response`. The same `initialData` drives both the SSR
 * markup (as props) and the serialized `window.__INITIAL_DATA__` the
 * client hydrates from, so the two surfaces agree by construction.
 */
async function renderAppResponse(
  title: string,
  pathname: string,
  initialData: InitialData,
): Promise<Response> {
  const html = await renderPage({
    title,
    component: App,
    props: { initialData, pathname },
    data: initialData,
  });

  return new Response(html, { headers: HTML_HEADERS });
}

/**
 * Builds the gateway's server-rendered page surface. Every route renders
 * the one real Svelte application, server-side, with the route's initial
 * data — the client then hydrates the same tree, so there is no
 * SSR/CSR structural mismatch to reconcile.
 */
export function createPages(dependencies: PageDependencies) {
  const app = new Hono();

  app.get('/', (context) => {
    return context.redirect('/dashboard');
  });

  app.get('/dashboard', async () => {
    const runs: RunSummary[] = dependencies.bureau.listRuns();
    return renderAppResponse('Dashboard', '/dashboard', { runs });
  });

  app.get('/runs/:id', async (context) => {
    const id = context.req.param('id');
    const run = buildRunDetailResponse(dependencies.bureau, id);
    if (!run) {
      return context.text('Run not found', 404);
    }
    return renderAppResponse(`Run ${run.id}`, `/runs/${run.id}`, { run });
  });

  // Same `reviews:read` scope as `GET /api/v1/reviews` (routes/index.ts) —
  // this SSR route embeds the same pending-review data (tool arguments,
  // prompts) in the hydration payload, so an under-scoped key must not be
  // able to read it here just because the JSON API is guarded.
  app.get('/reviews', createScopeGuard([SCOPE.REVIEWS_READ]), async () => {
    const reviews: PendingReview[] = dependencies.bureau.listPendingReviews();
    return renderAppResponse('Review Queue', '/reviews', { reviews });
  });

  // Same `runs:read` scope as `GET /api/v1/usage` (routes/index.ts) — this SSR
  // route embeds the same per-run usage/cost/attribution data, so an
  // under-scoped key must not be able to read it here just because the JSON
  // API is guarded.
  app.get('/usage', createScopeGuard([SCOPE.RUNS_READ]), async () => {
    const usage = buildUsageResponse(dependencies.bureau);
    return renderAppResponse('Usage', '/usage', { usage });
  });

  app.get('/configuration', async () => {
    // Inject the real ConfigurationResponse the page actually consumes
    // (provider, providers[], maximumSteps, systemPrompt, tools[]) instead
    // of the legacy `{ provider, maximumSteps, systemPrompt }` top-level
    // shape the client never read — the page no longer falls back to its
    // hardcoded defaults.
    const config = dependencies.bureau.getConfiguration();
    return renderAppResponse('Configuration', '/configuration', { config });
  });

  app.get('/chat', async () => {
    return renderAppResponse('Chat', '/chat', {});
  });

  app.get('/evaluations', async () => {
    const reports = dependencies.evaluationReportsDirectory
      ? await listEvaluationReports(dependencies.evaluationReportsDirectory)
      : [];
    return renderAppResponse('Evaluations', '/evaluations', { evaluations: { reports } });
  });

  return app;
}
