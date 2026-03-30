import { Conversation } from 'conversationalist';
import type { RunOptions, RunResult } from 'operative';
import { run, stopWhen } from 'operative';

import { matchOutput } from './matchers';
import { extractStepCount, extractTokenUsage, matchToolCalls } from './metrics';
import type {
  CreateAgentEvaluationOptions,
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationReport,
} from './types';

/**
 * Runs a single evaluation case against the configured agent, producing a case result
 * with pass/fail status, score, and collected metrics.
 */
async function runCase(
  evaluationCase: EvaluationCase,
  options: CreateAgentEvaluationOptions,
): Promise<EvaluationCaseResult> {
  const startTime = performance.now();
  const tags = evaluationCase.tags ?? [];

  try {
    const conversation = new Conversation();
    if (evaluationCase.systemPrompt) {
      conversation.appendSystemMessage(evaluationCase.systemPrompt);
    }
    conversation.appendUserMessage(evaluationCase.input);

    const timeout = evaluationCase.timeout ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let runOptions: RunOptions;

    const baseOptions = {
      conversation,
      signal: controller.signal,
      maximumSteps: evaluationCase.maxSteps ?? 25,
      stopWhen: stopWhen.noToolCalls(),
    };

    if ('run' in options.agent) {
      // AgentDefinition path — extract generate and toolbox from options
      const agentDef = options.agent;
      runOptions = {
        ...baseOptions,
        generate: agentDef.options.generate,
        toolbox: agentDef.options.toolbox,
      };
    } else {
      runOptions = {
        ...baseOptions,
        generate: options.agent.generate,
        toolbox: options.agent.toolbox,
      };
    }

    let runResult: RunResult;
    try {
      runResult = await run(runOptions);
    } finally {
      clearTimeout(timer);
    }

    const duration = performance.now() - startTime;
    const usage = extractTokenUsage(runResult);
    const steps = extractStepCount(runResult);

    // If the run itself errored, mark the case as failed immediately
    if (runResult.finishReason === 'error' && runResult.error !== undefined) {
      const rawError = runResult.error;
      const errorMessage =
        rawError instanceof Error
          ? rawError.message
          : typeof rawError === 'string'
            ? rawError
            : 'Unknown error';
      return {
        name: evaluationCase.name,
        tags,
        pass: false,
        score: 0,
        metrics: {
          outputMatch: false,
          toolCallMatch: false,
          steps,
          totalTokens: usage.total,
          cost: 0,
          duration,
          finishReason: runResult.finishReason,
        },
        error: errorMessage,
      };
    }

    const outputMatchResult = await matchOutput(runResult, evaluationCase, options.embedder);
    const toolCallMatch = matchToolCalls(runResult, evaluationCase.expectedToolCalls);

    const pass = outputMatchResult.pass && toolCallMatch;
    const score = toolCallMatch ? outputMatchResult.score : 0;

    return {
      name: evaluationCase.name,
      tags,
      pass,
      score,
      metrics: {
        outputMatch: outputMatchResult.pass,
        toolCallMatch,
        steps,
        totalTokens: usage.total,
        cost: 0,
        duration,
        finishReason: runResult.finishReason,
      },
    };
  } catch (error: unknown) {
    const duration = performance.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    return {
      name: evaluationCase.name,
      tags,
      pass: false,
      score: 0,
      metrics: {
        outputMatch: false,
        toolCallMatch: false,
        steps: 0,
        totalTokens: 0,
        cost: 0,
        duration,
        finishReason: 'error',
      },
      error: message,
    };
  }
}

/**
 * Runs a batch of evaluation cases with the given concurrency limit.
 */
async function runCasesWithConcurrency(
  cases: EvaluationCase[],
  options: CreateAgentEvaluationOptions,
  concurrency: number,
): Promise<EvaluationCaseResult[]> {
  const results: EvaluationCaseResult[] = [];
  const queue = [...cases];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const evaluationCase = queue.shift();
      if (!evaluationCase) break;
      const result = await runCase(evaluationCase, options);
      results.push(result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, cases.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

/**
 * Computes aggregate summary statistics from a list of case results.
 */
function computeSummary(cases: EvaluationCaseResult[]): EvaluationReport['summary'] {
  const total = cases.length;
  const passed = cases.filter((c) => c.pass).length;
  const failed = total - passed;
  const passRate = total > 0 ? passed / total : 0;

  const averageScore = total > 0 ? cases.reduce((sum, c) => sum + c.score, 0) / total : 0;
  const averageSteps = total > 0 ? cases.reduce((sum, c) => sum + c.metrics.steps, 0) / total : 0;
  const averageTokens =
    total > 0 ? cases.reduce((sum, c) => sum + c.metrics.totalTokens, 0) / total : 0;
  const averageCost = total > 0 ? cases.reduce((sum, c) => sum + c.metrics.cost, 0) / total : 0;
  const averageDuration =
    total > 0 ? cases.reduce((sum, c) => sum + c.metrics.duration, 0) / total : 0;
  const totalCost = cases.reduce((sum, c) => sum + c.metrics.cost, 0);

  return {
    total,
    passed,
    failed,
    passRate,
    averageScore,
    averageSteps,
    averageTokens,
    averageCost,
    averageDuration,
    totalCost,
  };
}

/**
 * Creates an evaluation runner that executes a set of evaluation cases against
 * an agent and produces an EvaluationReport with per-case results and summary
 * statistics.
 *
 * @example
 * ```ts
 * const evaluation = createAgentEvaluation({
 *   cases: [{ name: 'greeting', input: 'Say hello', expectedOutput: 'Hello!' }],
 *   agent: { generate, toolbox },
 * });
 * const report = await evaluation.run();
 * ```
 */
export function createAgentEvaluation(options: CreateAgentEvaluationOptions): {
  /** Runs all evaluation cases and returns the report. */
  run: () => Promise<EvaluationReport>;
} {
  const concurrency = options.concurrency ?? 1;

  return {
    async run(): Promise<EvaluationReport> {
      const caseResults = await runCasesWithConcurrency(options.cases, options, concurrency);

      return {
        timestamp: new Date().toISOString(),
        cases: caseResults,
        summary: computeSummary(caseResults),
      };
    },
  };
}
