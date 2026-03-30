# Model Routing by Task Complexity

## Overview

Herald's fallover (covered separately) handles _failures_—cascading to the next provider when one is down. Model routing handles _efficiency_: sending simple tasks to fast/cheap models and complex tasks to frontier models. This is the single biggest cost lever in production agent systems. A classification step that routes to gpt-4.1-nano instead of claude-opus saves 150x on that call.

This work adds a `createRoutingGenerate()` wrapper to herald that selects the appropriate model per request based on task signals.

## What Exists Today

Read these files to understand the current state:

- `packages/herald/src/types.ts` — `BaseProviderOptions`, `GenerateFunction`, `ProviderName`
- `packages/herald/src/anthropic.ts` — `createAnthropicGenerate()`
- `packages/herald/src/openai.ts` — `createOpenAIGenerate()`
- `packages/herald/src/gemini.ts` — `createGeminiGenerate()`
- `packages/operative/src/types.ts` — `GenerateContext` (what the router inspects)
- `packages/operative/src/cost-estimation.ts` — `defaultPricingTable`, `estimateCost()`

## Product Requirements

### PR-1: Router Interface

```typescript
interface RoutingOptions {
  /** Available models with their generate functions. */
  routes: ModelRoute[];
  /** Strategy for selecting a model. */
  strategy: RoutingStrategy;
  /** Called when a model is selected. */
  onRoute?: (event: RoutingEvent) => void;
  /** Fallback model when no route matches. Required. */
  fallback: string;
}

interface ModelRoute {
  /** Identifier used by the strategy (e.g., 'fast', 'smart', 'frontier'). */
  name: string;
  /** The generate function for this model. */
  generate: GenerateFunction;
  /** Cost tier for budget-aware routing. */
  costPerMillionTokens?: number;
}

interface RoutingEvent {
  selectedRoute: string;
  reason: string;
  context: GenerateContext;
  step: number;
}

type RoutingStrategy = (
  context: GenerateContext,
  routes: readonly ModelRoute[],
) => RoutingDecision;

interface RoutingDecision {
  route: string;
  reason: string;
}

function createRoutingGenerate(options: RoutingOptions): GenerateFunction;
```

### PR-2: Built-in Routing Strategies

**Complexity-based routing**: Analyze the conversation and tool context to estimate task complexity:

```typescript
interface ComplexitySignals {
  messageCount: number;
  toolCount: number;
  lastMessageLength: number;
  hasCodeContent: boolean;
  conversationDepth: number; // steps so far
  pendingToolResults: number;
}

function createComplexityStrategy(options: {
  /** Route name for simple tasks. */
  simple: string;
  /** Route name for complex tasks. */
  complex: string;
  /** Route name for frontier tasks. Default: same as complex. */
  frontier?: string;
  /** Custom complexity scorer. Default: built-in heuristic. */
  scorer?: (signals: ComplexitySignals) => 'simple' | 'complex' | 'frontier';
}): RoutingStrategy;
```

Default scoring heuristic:
- Simple: < 3 tools, last message < 500 chars, no code, < 5 conversation turns
- Complex: 3-10 tools, or code content, or > 500 char message
- Frontier: > 10 tools, or > 2000 char message, or > 20 conversation turns

**Step-based routing**: Different models for different phases of the agent loop:

```typescript
function createStepBasedStrategy(options: {
  /** Route for the first step (often needs strongest reasoning). */
  first: string;
  /** Route for middle steps (tool execution, usually simpler). */
  middle: string;
  /** Route for the final step (synthesis/summary). */
  last?: string;
  /** Step number threshold for switching to middle. Default: 1. */
  middleAfterStep?: number;
}): RoutingStrategy;
```

**Cost-aware routing**: Prefer cheaper models when budget is running low:

```typescript
function createCostAwareStrategy(options: {
  /** Budget remaining threshold (0-1) below which to prefer cheap models. */
  thresholdRatio: number;
  /** Current budget state. */
  getBudgetState: () => { spent: number; budget: number };
  /** Route for cheap model. */
  cheap: string;
  /** Route for expensive model. */
  expensive: string;
}): RoutingStrategy;
```

**Composite strategy**: Combine multiple strategies with priority:

```typescript
function composeStrategies(...strategies: RoutingStrategy[]): RoutingStrategy;
```

First strategy to return a non-fallback decision wins.

### PR-3: Strategy Composition with Fallback

When no strategy produces a decision, use the `fallback` route. When the selected route's generate function fails, optionally fall through to the next route (integrates with the fallover system).

### PR-4: Routing Metrics

Track which routes are used and their relative performance:

```typescript
interface RoutingMetrics {
  readonly routeCounts: ReadonlyMap<string, number>;
  readonly routeCosts: ReadonlyMap<string, number>;
  readonly routeLatencies: ReadonlyMap<string, number[]>;
  reset(): void;
}

function withRoutingMetrics(
  generate: GenerateFunction,
  options: RoutingOptions,
): { generate: GenerateFunction; metrics: RoutingMetrics };
```

## Architecture

### New Files

In `packages/herald/src/routing/`:

- `types.ts` — `RoutingOptions`, `ModelRoute`, `RoutingStrategy`, `RoutingDecision`, `RoutingEvent`, `RoutingMetrics`
- `create-routing-generate.ts` — `createRoutingGenerate()` factory
- `strategies/complexity.ts` — `createComplexityStrategy()`
- `strategies/step-based.ts` — `createStepBasedStrategy()`
- `strategies/cost-aware.ts` — `createCostAwareStrategy()`
- `strategies/compose.ts` — `composeStrategies()`
- `routing-metrics.ts` — `withRoutingMetrics()` wrapper
- `index.ts` — re-exports

### Extended Files

- `packages/herald/src/index.ts` — re-export routing modules
- `packages/herald/package.json` — add `"./routing"` subpath export

## Implementation Order (TDD)

### Phase 1: Complexity Strategy

1. Write tests:
   - Simple signals → routes to `simple` model
   - Complex signals (many tools, code content) → routes to `complex` model
   - Frontier signals (long message, deep conversation) → routes to `frontier` model
   - Custom scorer overrides default heuristic
   - All signal fields correctly extracted from `GenerateContext`
2. Implement `strategies/complexity.ts`
3. Verify: `bun test packages/herald/src/routing/strategies/complexity.test.ts`

### Phase 2: Step-Based Strategy

1. Write tests:
   - Step 0 → `first` route
   - Step 1+ → `middle` route
   - Custom `middleAfterStep` threshold
   - `last` route (when configured and on final step based on context signals)
2. Implement `strategies/step-based.ts`
3. Verify: `bun test packages/herald/src/routing/strategies/step-based.test.ts`

### Phase 3: Cost-Aware Strategy

1. Write tests:
   - Above threshold → `expensive` route
   - Below threshold → `cheap` route
   - Exact threshold → `cheap` route
   - Budget state queried fresh each call
2. Implement `strategies/cost-aware.ts`
3. Verify: `bun test packages/herald/src/routing/strategies/cost-aware.test.ts`

### Phase 4: Strategy Composition

1. Write tests:
   - Single strategy → returns its decision
   - Two strategies → first non-fallback wins
   - All strategies return fallback → fallback used
2. Implement `strategies/compose.ts`
3. Verify: `bun test packages/herald/src/routing/strategies/compose.test.ts`

### Phase 5: Routing Generate

1. Write tests for `createRoutingGenerate()`:
   - Strategy selects route → that route's generate is called
   - `onRoute` callback fires with selection details
   - Unknown route name → fallback used
   - Fallback route always works
   - Context passed through to selected generate unchanged
   - Response from selected generate returned unchanged
2. Implement `create-routing-generate.ts`
3. Verify: `bun test packages/herald/src/routing/create-routing-generate.test.ts`

### Phase 6: Routing Metrics

1. Write tests:
   - Route counts tracked per route name
   - Route costs accumulated from token usage
   - Route latencies recorded as arrays
   - `reset()` clears all data
2. Implement `routing-metrics.ts`
3. Verify: `bun test packages/herald/src/routing/routing-metrics.test.ts`

### Phase 7: Integration

1. Wire exports and subpath
2. Run full suite: `turbo run validate`

## Acceptance Criteria

- [ ] `createRoutingGenerate()` exported from `herald` and `herald/routing`
- [ ] `createComplexityStrategy()` routes by task complexity signals
- [ ] `createStepBasedStrategy()` routes by step number
- [ ] `createCostAwareStrategy()` routes by remaining budget
- [ ] `composeStrategies()` combines multiple strategies
- [ ] Strategy returns route name, router calls the matching generate function
- [ ] `onRoute` callback fires with selection details
- [ ] Fallback route used when no strategy matches
- [ ] `withRoutingMetrics()` tracks route usage, cost, and latency
- [ ] Routing is transparent: context and response pass through unchanged
- [ ] Default complexity heuristic correctly classifies simple vs. complex vs. frontier
- [ ] 100% test coverage: `bun test --coverage packages/herald/src/routing/`
- [ ] `turbo run validate` passes from monorepo root
- [ ] No new runtime dependencies
- [ ] All public functions have JSDoc descriptions

## Verification Commands

```bash
bun test packages/herald/src/routing/        # Routing tests
bun test --coverage packages/herald/         # Coverage
turbo run check-types --filter=herald        # Type check
turbo run lint --filter=herald               # Lint
turbo run validate                           # Full pipeline
```

<promise>MODEL_ROUTING_COMPLETE</promise>
<promise>MODEL_ROUTING_FAILED</promise>
