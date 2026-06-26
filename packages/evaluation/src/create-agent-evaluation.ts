import { Conversation } from 'conversationalist';
import type { RunResult } from 'operative';
import { createActiveRun, stopWhen } from 'operative';

import { matchOutput } from './matchers';
import { extractStepCount, extractTokenUsage, matchToolCalls } from './metrics';
import type {
  CreateAgentEvaluationOptions,
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationReport,
} from './types';

function getFailureMessage(runResult: RunResult): string {
  const rawError = runResult.error;
  if (rawError instanceof Error) return rawError.message;
  if (typeof rawError === 'string') return rawError;
  return runResult.finishReason === 'error'
    ? 'Unknown error'
    : `Run ended with finish reason: ${runResult.finishReason}`;
}

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
    const timeout = evaluationCase.timeout ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let runResult: RunResult;
    try {
      if ('generate' in options.agent) {
        // Bare generate+toolbox path: build a conversation and run the loop
        const conversation = new Conversation();
        if (evaluationCase.systemPrompt) {
          conversation.appendSystemMessage(evaluationCase.systemPrompt);
        }
        conversation.appendUserMessage(evaluationCase.input);

        runResult = await createActiveRun({
          conversation,
          signal: controller.signal,
          maximumSteps: evaluationCase.maxSteps ?? 25,
          stopWhen: stopWhen.noToolCalls(),
          generate: options.agent.generate,
          toolbox: options.agent.toolbox,
        }).result;
      } else {
        // RegistryAgent path: call the agent's run method directly.
        // RegistryAgent.run() does not accept a systemPrompt — the agent's
        // instructions are baked in at construction time. Fail loudly rather
        // than silently dropping the override.
        if (evaluationCase.systemPrompt) {
          throw new Error(
            `Evaluation case "${evaluationCase.name}" specifies systemPrompt, but RegistryAgent does not support per-case system prompt overrides. Remove the systemPrompt from the case or use the generate+toolbox agent shape instead.`,
          );
        }

        // RegistryAgent.run() accepts only { signal, traceContext } — there is no
        // per-case step cap. Silently ignoring maxSteps would let cases meant to
        // catch looping/excessive tool use run under the agent's own/default
        // limit. Fail loudly, mirroring the systemPrompt rejection above.
        if (evaluationCase.maxSteps !== undefined) {
          throw new Error(
            `Evaluation case "${evaluationCase.name}" specifies maxSteps, but RegistryAgent does not support a per-case step cap (its run() accepts only { signal }). Remove maxSteps from the case or use the generate+toolbox agent shape instead.`,
          );
        }
        const agentResult = await options.agent.run(evaluationCase.input, {
          signal: controller.signal,
        });
        runResult = agentResult as RunResult;
      }
    } finally {
      clearTimeout(timer);
    }

    const duration = performance.now() - startTime;
    const usage = extractTokenUsage(runResult);
    const steps = extractStepCount(runResult);

    if (runResult.finishReason === 'error' || runResult.finishReason === 'aborted') {
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
          duration,
          finishReason: runResult.finishReason,
        },
        error: getFailureMessage(runResult),
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
        duration,
        finishReason: 'error',
      },
      error: message,
    };
  }
}

/**
 * Runs a batch of evaluation cases with the given concurrency limit,
 * preserving the input order of cases in the results array.
 */
async function runCasesWithConcurrency(
  cases: EvaluationCase[],
  options: CreateAgentEvaluationOptions,
  concurrency: number,
): Promise<EvaluationCaseResult[]> {
  const results = new Array<EvaluationCaseResult>(cases.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < cases.length) {
      const index = nextIndex++;
      const evaluationCase = cases[index];
      if (!evaluationCase) break;
      results[index] = await runCase(evaluationCase, options);
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
  const averageDuration =
    total > 0 ? cases.reduce((sum, c) => sum + c.metrics.duration, 0) / total : 0;

  return {
    total,
    passed,
    failed,
    passRate,
    averageScore,
    averageSteps,
    averageTokens,
    averageDuration,
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
  const concurrency = Math.max(1, options.concurrency ?? 1);

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
