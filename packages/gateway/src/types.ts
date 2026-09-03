import type {
  SessionInputAdmissionOutcome,
  SessionInputAdmissionRequest,
} from '@lostgradient/operative/durable';
import type { Store } from '@lostgradient/operative/store';
import type { EvaluationReportSummary } from 'evaluation';
import type { Hono } from 'hono';

export type {
  AuditEventType,
  AuditQueryOptions,
  AuditRecord,
  AuditTrail,
  Bureau,
  BureauEventMap,
  BureauEventType,
  BureauOptions,
  ConfigurationResponse,
  CreateRunRequest,
  DurableScheduleDefinition,
  PendingHumanWaitReview,
  PendingReview,
  PendingToolApprovalReview,
  PersistenceOptions,
  ProviderConfiguration,
  ResolveReviewInput,
  ResolveReviewResult,
  RunDetail,
  RunEventRecord,
  RunStepDetail,
  RunSummary,
  ServerFrame,
  SubmitSchedulerTaskRequest,
  SubmitSchedulerTaskResponse,
  ToolPolicy,
  ToolSummary,
} from 'bureau';
export { DEFAULT_MAXIMUM_STEPS } from 'bureau';
export type { EvaluationReportSummary } from 'evaluation';
export type { SessionInputAdmissionOutcome, SessionInputAdmissionRequest };

// ── Gateway (HTTP door — door-only config, no brain options) ────────

/**
 * Door-only configuration for `createGateway`. Does NOT extend
 * {@link BureauOptions} — the bureau (brain) is constructed by the caller
 * and passed in as arg 1. This object contains only transport-layer knobs.
 */
export interface GatewayOptions {
  port?: number;
  hostname?: string;
  authToken?: string;
  /** Server runtime. Default: auto-detected (`'bun'` when `typeof Bun !== 'undefined'`, `'node'` otherwise). */
  runtime?: 'bun' | 'node';
  /**
   * Explicit list of allowed origins for WebSocket upgrade requests. When non-empty,
   * upgrade requests whose `Origin` header is absent or not in the list are rejected
   * with 403. When omitted, no origin check is performed.
   */
  allowedOrigins?: string[];
  /**
   * Emit a `Content-Security-Policy` header on every response. Defaults to `true`.
   */
  enableCsp?: boolean;
  /**
   * Server idle timeout in seconds. Connections that are silent for longer
   * than this period are closed by the runtime.
   *
   * For SSE streams: the heartbeat must fire before this threshold or the
   * connection will be silently dropped. The default heartbeat interval
   * (8 s) is tuned for Bun's 10 s default. Raise both together if your
   * environment allows longer idle periods (e.g. nginx default: 75 s).
   *
   * Bun default: 10 s.
   */
  idleTimeout?: number;
  /**
   * Directory containing evaluation report JSON files (written by
   * `runEvaluationSuite`'s `output` option) for the read-only
   * `/evaluations` trend page. When omitted, the page renders empty —
   * evaluation reporting is opt-in.
   */
  evaluationReportsDirectory?: string;
  /**
   * AB-71 — A2A (Agent2Agent) server facade. Configures the Agent Card served
   * at `GET /.well-known/agent-card.json` and the `POST /a2a` JSON-RPC
   * endpoint's self-description. Omit to use generic defaults derived from
   * `bureau.getConfiguration()`.
   */
  a2a?: A2AAgentCardOptions;
  /**
   * AB-235 — bounds how long `stop()` waits for open connections (in-flight
   * requests, open WebSockets, live SSE streams) to drain before forcing
   * them closed, so a deployment's shutdown grace period is never held
   * open indefinitely by an attached UI client. Omit to use
   * `DEFAULT_GATEWAY_DRAIN_TIMEOUT_MS`.
   */
  shutdown?: GatewayShutdownOptions;
}

/** AB-235 — {@link GatewayOptions.shutdown}. */
export interface GatewayShutdownOptions {
  /**
   * Milliseconds to wait for open connections to drain during `stop()`
   * before force-closing whatever remains. Must be a positive integer.
   * Default: {@link DEFAULT_GATEWAY_DRAIN_TIMEOUT_MS} (10000).
   */
  drainTimeoutMs?: number;
}

/**
 * AB-235 — the report `Gateway['start']`'s returned `stop()` resolves with.
 * `drained: true` means every open connection closed on its own before the
 * drain timeout; `drained: false` means `stop()` had to force-close
 * whatever the server adapter still had open.
 *
 * `forcedConnections` counts the live-frame connections (open WebSockets
 * and SSE streams, tracked via `live-events.ts`'s subscriber registry) that
 * were still open at the moment force-close ran — the "attached UI client"
 * scenario this issue exists to bound. It is not a count of every raw TCP
 * connection the adapter force-closed: an ordinary in-flight HTTP request
 * force-closed at the same moment is not counted here, since it is not
 * tracked by the broker and (unlike a parked WebSocket/SSE stream) cannot
 * hold shutdown open indefinitely on its own — it is bounded by the
 * request's own handling, well inside `drainTimeoutMs` in practice.
 */
export interface GatewayShutdownReport {
  drained: boolean;
  forcedConnections: number;
}

/**
 * Operator-supplied metadata for the A2A Agent Card (AB-71). Everything is
 * optional — the card renders with generic defaults when omitted, since
 * `bureau` has no first-class "agent identity" concept of its own (a bureau
 * is one or more agents dispatched by name, not a single named entity).
 */
export interface A2AAgentCardOptions {
  /** Human-readable agent name. Default: `'Agent Bureau'`. */
  name?: string;
  /** Human-readable description. Default: a generic bureau description. */
  description?: string;
  /** Agent/deploy version string (e.g. `'1.4.2'`). Default: `'0.0.0'`. */
  version?: string;
  /** Service provider identity, surfaced on the card's `provider` field. */
  provider?: { organization: string; url: string };
  /** URL to an icon representing the agent. */
  iconUrl?: string;
  /**
   * Absolute base URL this gateway is publicly reachable at (e.g.
   * `'https://agents.example.com'`), used to build the Agent Card's
   * `supportedInterfaces[].url`. Defaults to the incoming request's own
   * origin (scheme + host) — the right default for direct exposure, but
   * required when a reverse proxy rewrites the request `Host` before it
   * reaches the gateway.
   */
  baseUrl?: string;
}

export interface Gateway {
  readonly app: Hono;
  readonly bureau: import('bureau').Bureau;
  readonly store: Store;
  readonly port: number;
  start(): Promise<{
    /**
     * The port the server actually bound to (AB-272). When `options.port`
     * was `0` (ephemeral allocation), this is the operating-system-assigned
     * port — `Gateway.port` above stays the requested value (`0`) and is
     * not useful for discovering it.
     */
    readonly port: number;
    stop(): Promise<GatewayShutdownReport>;
  }>;
}

// ── API Response Types (door-only) ──────────────────────────────────

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

/**
 * The `/evaluations` page's hydration payload: eval report summaries sorted
 * oldest to newest, the shape a pass-rate/cost trend view reads directly.
 * Empty when `evaluationReportsDirectory` isn't configured.
 */
export interface EvaluationReportsResponse {
  reports: EvaluationReportSummary[];
}

// ── WebSocket Frame Types (door-only client frames) ─────────────────

export type ClientFrame =
  | {
      type: 'subscribe';
      runId: string;
      /**
       * AB-15 replay cursor: the highest `ServerFrame.runSeq` this client has
       * already seen for `runId`. When present, the door replays buffered
       * frames with `runSeq > since` before the subscription goes live.
       * Omit for a fresh subscription with no replay.
       */
      since?: number;
    }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'ping' };

// ── Health Types ────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok' | 'unavailable';
}

/**
 * `GET /api/v1/health/ready`'s body shape (AB-219). Replaces the single
 * aggregate `{ status: 'ok' | 'unavailable' }` ({@link HealthResponse})
 * with named subsystem evidence: `bureau` mirrors today's `bureau.ready`
 * check exactly (no regression — `503` when
 * `bureau` is `'unavailable'`, matching the prior behavior), and
 * `connections` aggregates the Gateway connection watchdog's per-connection
 * `LivenessSnapshot.reachability` assessments (`live-events.ts`'s
 * `getConnectionRegistry()`). `status: 'degraded'` is a new, additive
 * classification returned with HTTP `200` — a consumer that only checks the
 * HTTP status code sees no new failure mode.
 */
export interface ReadyResponse {
  status: 'ok' | 'degraded' | 'unavailable';
  subsystems: {
    bureau: 'ok' | 'unavailable';
    connections: {
      total: number;
      late: number;
      unreachable: number;
    };
  };
}

// ── Constants ───────────────────────────────────────────────────────

export const DEFAULT_PORT = 5555;

// ── API Key Scopes ─────────────────────────────────────────────────

/** Scope definitions for route-level authorization. */
export const SCOPE = {
  RUNS_READ: 'runs:read',
  RUNS_WRITE: 'runs:write',
  SESSIONS_READ: 'sessions:read',
  SESSIONS_WRITE: 'sessions:write',
  CONFIG_READ: 'config:read',
  KEYS_MANAGE: 'keys:manage',
  /** Webhook ingress — typed dispatch endpoints (`POST /hooks/*`). */
  HOOKS_WRITE: 'hooks:write',
  SCHEDULES_READ: 'schedules:read',
  SCHEDULES_WRITE: 'schedules:write',
  /** The review queue (AB-20): parked tool approvals and human-input waits. */
  REVIEWS_READ: 'reviews:read',
  /** Approve/deny a pending review — deliberately its own scope, not folded
   * into `runs:write`, since it grants the ability to resume a parked run or
   * execute a previously-gated tool call. */
  REVIEWS_WRITE: 'reviews:write',
} as const;

export type Scope = (typeof SCOPE)[keyof typeof SCOPE];
