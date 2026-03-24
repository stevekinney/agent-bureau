import type { Toolbox } from 'armorer';
import type { SessionPersistenceAdapter } from 'conversationalist';
import type { ProviderName } from 'herald';
import type { Hono } from 'hono';
import type { GenerateFunction, StopCondition } from 'operative';
import type { Store } from 'sentinel';

// ── Gateway Configuration ───────────────────────────────────────────

export interface ProviderConfiguration {
  provider: ProviderName;
  model: string;
  maximumTokens?: number;
  temperature?: number;
  apiKey?: string;
}

export interface GatewayOptions {
  generate?: GenerateFunction;
  provider?: ProviderConfiguration;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolbox?: Toolbox<any>;
  store?: Store;
  persistence?: SessionPersistenceAdapter;
  stopWhen?: StopCondition | StopCondition[];
  maximumSteps?: number;
  systemPrompt?: string;
  port?: number;
  hostname?: string;
  authToken?: string;
}

export interface Gateway {
  readonly app: Hono;
  readonly store: Store;
  readonly port: number;
  start(): { stop(): void };
}

// ── API Response Types ──────────────────────────────────────────────

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export interface RunSummary {
  id: string;
  status: string;
  steps: number;
  usage: { prompt: number; completion: number; total: number };
  finishReason: string | undefined;
  error: string | undefined;
  actionCount: number;
}

export interface CreateRunRequest {
  message: string;
  conversationId?: string;
  systemPrompt?: string;
  maximumSteps?: number;
}

export interface ConfigurationResponse {
  provider: ProviderConfiguration | undefined;
  maximumSteps: number;
  systemPrompt: string | undefined;
  tools: ToolSummary[];
}

export interface ToolSummary {
  name: string;
  description: string;
}

// ── WebSocket Frame Types ───────────────────────────────────────────

export type ClientFrame =
  | { type: 'subscribe'; runId: string }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'ping' };

export type ServerFrame =
  | { type: 'event'; runId: string; event: string; detail: unknown; timestamp: number }
  | { type: 'subscribed'; runId: string }
  | { type: 'unsubscribed'; runId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

// ── Health Types ────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok' | 'unavailable';
}

// ── Constants ───────────────────────────────────────────────────────

export const DEFAULT_PORT = 5555;
export const DEFAULT_MAXIMUM_STEPS = 10;
