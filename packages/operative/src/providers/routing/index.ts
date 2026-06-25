export { createRoutingGenerate } from './create-routing-generate.ts';
export { withRoutingMetrics } from './routing-metrics.ts';
export type { ComplexityStrategyOptions } from './strategies/complexity.ts';
export { createComplexityStrategy, extractComplexitySignals } from './strategies/complexity.ts';
export { composeStrategies } from './strategies/compose.ts';
export type { CostAwareStrategyOptions } from './strategies/cost-aware.ts';
export { createCostAwareStrategy } from './strategies/cost-aware.ts';
export type { StepBasedStrategyOptions } from './strategies/step-based.ts';
export { createStepBasedStrategy } from './strategies/step-based.ts';
export type {
  ComplexitySignals,
  ModelRoute,
  RoutingDecision,
  RoutingEvent,
  RoutingMetrics,
  RoutingMetricsResult,
  RoutingOptions,
  RoutingStrategy,
} from './types.ts';
