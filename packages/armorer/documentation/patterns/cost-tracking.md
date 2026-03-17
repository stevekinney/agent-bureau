# Cost Tracking

Monitor API costs and usage quotas.

```typescript
import { createToolbox, createMiddleware } from 'armorer';

interface CostEntry {
  toolName: string;
  timestamp: number;
  cost: number;
  units: number;
  metadata?: Record<string, unknown>;
}

class CostTracker {
  private entries: CostEntry[] = [];
  private totalCost = 0;

  addCost(entry: CostEntry): void {
    this.entries.push(entry);
    this.totalCost += entry.cost;
  }

  getTotalCost(): number {
    return this.totalCost;
  }

  getCostByTool(toolName: string): number {
    return this.entries
      .filter((e) => e.toolName === toolName)
      .reduce((sum, e) => sum + e.cost, 0);
  }

  getUsageStats(): Record<string, { calls: number; cost: number; units: number }> {
    const stats: Record<string, { calls: number; cost: number; units: number }> = {};

    for (const entry of this.entries) {
      if (!stats[entry.toolName]) {
        stats[entry.toolName] = { calls: 0, cost: 0, units: 0 };
      }
      stats[entry.toolName].calls++;
      stats[entry.toolName].cost += entry.cost;
      stats[entry.toolName].units += entry.units;
    }

    return stats;
  }
}

// Cost calculator function type
type CostCalculator = (
  params: unknown,
  result: unknown,
) => {
  cost: number;
  units: number;
};

// Create cost tracking middleware
function createCostTrackingMiddleware(
  tracker: CostTracker,
  costCalculators: Map<string, CostCalculator>,
) {
  return createMiddleware((toolConfiguration) => {
    const toolName = toolConfiguration.identity.name;
    const originalExecute = toolConfiguration.execute;
    const calculator = costCalculators.get(toolName);

    return {
      ...toolConfiguration,
      async execute(params: unknown, context: unknown) {
        const executeFn =
          typeof originalExecute === 'function' ? originalExecute : await originalExecute;

        const result = await executeFn(params, context);

        // Calculate and track cost
        if (calculator) {
          const { cost, units } = calculator(params, result);
          tracker.addCost({
            toolName,
            timestamp: Date.now(),
            cost,
            units,
          });
        }

        return result;
      },
    };
  });
}

// Example: OpenAI GPT-4 cost calculator
const costCalculators = new Map<string, CostCalculator>([
  [
    'openai-completion',
    (params: any, result: any) => {
      // GPT-4 pricing: $0.03/1K input tokens, $0.06/1K output tokens
      const inputTokens = result.usage?.prompt_tokens ?? 0;
      const outputTokens = result.usage?.completion_tokens ?? 0;

      const inputCost = (inputTokens / 1000) * 0.03;
      const outputCost = (outputTokens / 1000) * 0.06;

      return {
        cost: inputCost + outputCost,
        units: inputTokens + outputTokens,
      };
    },
  ],
]);

const costTracker = new CostTracker();

const toolbox = createToolbox([], {
  middleware: [createCostTrackingMiddleware(costTracker, costCalculators)],
});

// Check costs
console.log('Total cost:', costTracker.getTotalCost());
console.log('Usage stats:', costTracker.getUsageStats());

// Alert on high costs
if (costTracker.getTotalCost() > 10.0) {
  console.warn('Cost threshold exceeded!');
}
```

## Per-User Cost Quotas

```typescript
class QuotaManager {
  private usage = new Map<string, number>();

  constructor(private quotas: Map<string, number>) {}

  checkQuota(userId: string, cost: number): boolean {
    const used = this.usage.get(userId) ?? 0;
    const quota = this.quotas.get(userId) ?? 0;
    return used + cost <= quota;
  }

  addUsage(userId: string, cost: number): void {
    const used = this.usage.get(userId) ?? 0;
    this.usage.set(userId, used + cost);
  }

  getRemainingQuota(userId: string): number {
    const used = this.usage.get(userId) ?? 0;
    const quota = this.quotas.get(userId) ?? 0;
    return Math.max(0, quota - used);
  }
}

function createQuotaMiddleware(
  quotaManager: QuotaManager,
  costCalculators: Map<string, CostCalculator>,
) {
  return createMiddleware((toolConfiguration) => {
    const toolName = toolConfiguration.identity.name;
    const originalExecute = toolConfiguration.execute;
    const calculator = costCalculators.get(toolName);

    return {
      ...toolConfiguration,
      async execute(params: unknown, context: any) {
        const userId = context.userId;
        if (!userId) {
          throw new Error('User ID required for quota enforcement');
        }

        // Estimate cost (simplified - actual cost checked after execution)
        const estimatedCost = 0.1; // Could be more sophisticated
        if (!quotaManager.checkQuota(userId, estimatedCost)) {
          throw new Error(
            `Quota exceeded for user ${userId}. Remaining: ${quotaManager.getRemainingQuota(userId)}`,
          );
        }

        const executeFn =
          typeof originalExecute === 'function' ? originalExecute : await originalExecute;

        const result = await executeFn(params, context);

        // Track actual cost
        if (calculator) {
          const { cost } = calculator(params, result);
          quotaManager.addUsage(userId, cost);
        }

        return result;
      },
    };
  });
}

// Usage
const quotas = new Map([
  ['user-123', 100.0], // $100 quota
  ['user-456', 50.0], // $50 quota
]);

const quotaManager = new QuotaManager(quotas);

const toolbox = createToolbox([], {
  middleware: [createQuotaMiddleware(quotaManager, costCalculators)],
  context: { userId: 'user-123' },
});
```
