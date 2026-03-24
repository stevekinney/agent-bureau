import type { CostEstimationOptions } from './cost-estimation';
import { estimateCost } from './cost-estimation';
import type { StopCondition } from './types';

export interface CostBudgetThresholdEvent {
  threshold: number;
  currentCost: number;
  budget: number;
  model: string;
}

export interface CostBudgetExceededEvent {
  currentCost: number;
  budget: number;
  model: string;
}

export interface CostBudgetOptions {
  budget: number;
  model: string;
  thresholds?: number[];
  onThreshold?: (event: CostBudgetThresholdEvent) => void;
  onExceeded?: (event: CostBudgetExceededEvent) => void;
  pricing?: CostEstimationOptions;
}

export interface CostBudgetMonitor {
  readonly stopCondition: StopCondition;
  readonly currentCost: number;
  readonly firedThresholds: readonly number[];
}

export function createCostBudgetMonitor(options: CostBudgetOptions): CostBudgetMonitor {
  const { budget, model, thresholds = [], onThreshold, onExceeded, pricing } = options;

  let accumulated = 0;
  const firedThresholds: number[] = [];
  const sortedThresholds = [...thresholds].sort((a, b) => a - b);

  const stopCondition: StopCondition = (context) => {
    if (context.usage) {
      const estimate = estimateCost(context.usage, model, pricing);
      accumulated += estimate.totalCost;
    }

    for (const threshold of sortedThresholds) {
      if (firedThresholds.includes(threshold)) continue;
      if (accumulated >= threshold * budget) {
        firedThresholds.push(threshold);
        onThreshold?.({
          threshold,
          currentCost: accumulated,
          budget,
          model,
        });
      }
    }

    if (accumulated >= budget) {
      onExceeded?.({
        currentCost: accumulated,
        budget,
        model,
      });
      return true;
    }

    return false;
  };

  return {
    get stopCondition() {
      return stopCondition;
    },
    get currentCost() {
      return accumulated;
    },
    get firedThresholds() {
      return firedThresholds as readonly number[];
    },
  };
}
