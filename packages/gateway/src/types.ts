import type { Hono } from 'hono';
import type { Store } from 'operative/store';

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
  PersistenceOptions,
  ProviderConfiguration,
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
}

export interface Gateway {
  readonly app: Hono;
  readonly bureau: import('bureau').Bureau;
  readonly store: Store;
  readonly port: number;
  start(): Promise<{ stop(): void }>;
}

// ── API Response Types (door-only) ──────────────────────────────────

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

// ── WebSocket Frame Types (door-only client frames) ─────────────────

export type ClientFrame =
  | { type: 'subscribe'; runId: string }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'ping' };

// ── Health Types ────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok' | 'unavailable';
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
} as const;

export type Scope = (typeof SCOPE)[keyof typeof SCOPE];
