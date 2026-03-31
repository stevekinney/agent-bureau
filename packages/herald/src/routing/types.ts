import type { GenerateContext, GenerateFunction, GenerateResponse } from '../types.ts';

/**
 * Options for configuring model routing behavior.
 */
export type RoutingOptions = {
  /** Available models with their generate functions. */
  routes: ModelRoute[];
  /** Strategy for selecting a model. */
  strategy: RoutingStrategy;
  /** Called when a model is selected. */
  onRoute?: (event: RoutingEvent) => void;
  /** Fallback route name when no strategy matches. Required. */
  fallback: string;
};

/**
 * A named model route with its generate function and optional cost metadata.
 */
export type ModelRoute = {
  /** Identifier used by the strategy (e.g., 'fast', 'smart', 'frontier'). */
  name: string;
  /** The generate function for this model. */
  generate: GenerateFunction;
  /** Cost per million tokens for budget-aware routing. */
  costPerMillionTokens?: number;
};

/**
 * Event emitted when a route is selected for a generate call.
 */
export type RoutingEvent = {
  selectedRoute: string;
  reason: string;
  context: GenerateContext;
  step: number;
};

/**
 * A function that inspects the generate context and selects a route.
 */
export type RoutingStrategy = (
  context: GenerateContext,
  routes: readonly ModelRoute[],
) => RoutingDecision;

/**
 * The result of a routing strategy evaluation.
 */
export type RoutingDecision = {
  route: string;
  reason: string;
};

/**
 * Tracked metrics for routing decisions across generate calls.
 */
export type RoutingMetrics = {
  readonly routeCounts: ReadonlyMap<string, number>;
  readonly routeCosts: ReadonlyMap<string, number>;
  readonly routeLatencies: ReadonlyMap<string, number[]>;
  reset(): void;
};

/**
 * Signals extracted from a GenerateContext for complexity scoring.
 */
export type ComplexitySignals = {
  messageCount: number;
  toolCount: number;
  lastMessageLength: number;
  hasCodeContent: boolean;
  conversationDepth: number;
  pendingToolResults: number;
};

/**
 * Return type from withRoutingMetrics — the wrapped generate function and its metrics handle.
 */
export type RoutingMetricsResult = {
  generate: GenerateFunction;
  metrics: RoutingMetrics;
};

/**
 * Internal type for the generate response with usage data, used by metrics tracking.
 */
export type { GenerateContext, GenerateFunction, GenerateResponse };
