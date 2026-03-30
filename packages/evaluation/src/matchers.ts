import type { RunResult } from 'operative';

import type {
  EmbedderFunction,
  EvaluationAssertion,
  EvaluationCase,
  MatchResult,
  SemanticMatcher,
} from './types';

/**
 * Checks whether the actual output exactly matches the expected string (case-sensitive).
 */
export function matchExact(actual: string, expected: string): MatchResult {
  const pass = actual === expected;
  return {
    pass,
    score: pass ? 1 : 0,
    message: pass
      ? `Output matched exactly: "${expected}"`
      : `Expected "${expected}" but got "${actual}"`,
  };
}

/**
 * Checks whether the actual output matches the given regular expression.
 */
export function matchRegex(actual: string, pattern: RegExp): MatchResult {
  const pass = pattern.test(actual);
  return {
    pass,
    score: pass ? 1 : 0,
    message: pass
      ? `Output matched pattern: ${pattern}`
      : `Output did not match pattern: ${pattern}. Got: "${actual}"`,
  };
}

/**
 * Checks whether the actual output contains the given substring.
 */
export function matchSubstring(actual: string, substring: string): MatchResult {
  const pass = actual.includes(substring);
  return {
    pass,
    score: pass ? 1 : 0,
    message: pass
      ? `Output contains substring: "${substring}"`
      : `Output does not contain substring: "${substring}". Got: "${actual}"`,
  };
}

/**
 * Computes cosine similarity between two numeric vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Checks whether the actual output is semantically similar to the reference text
 * above the configured threshold, using the provided embedder function.
 */
export async function matchSemantic(
  actual: string,
  matcher: SemanticMatcher,
  embedder: EmbedderFunction | undefined,
): Promise<MatchResult> {
  if (!embedder) {
    return {
      pass: false,
      score: 0,
      message: 'Semantic matching requires an embedder function but none was provided',
    };
  }

  const [actualEmbedding, referenceEmbedding] = await Promise.all([
    embedder(actual),
    embedder(matcher.reference),
  ]);

  const similarity = cosineSimilarity(actualEmbedding, referenceEmbedding);
  const pass = similarity >= matcher.threshold;

  return {
    pass,
    score: Math.max(0, Math.min(1, similarity)),
    message: pass
      ? `Semantic similarity ${similarity.toFixed(3)} meets threshold ${matcher.threshold}`
      : `Semantic similarity ${similarity.toFixed(3)} is below threshold ${matcher.threshold}`,
  };
}

/**
 * Runs a custom assertion function against the full RunResult and normalizes the output.
 */
export function matchCustomAssertion(
  runResult: RunResult,
  assertFn: (result: RunResult) => EvaluationAssertion,
): MatchResult {
  try {
    const assertion = assertFn(runResult);
    const score = assertion.score ?? (assertion.pass ? 1 : 0);
    return {
      pass: assertion.pass,
      score,
      message:
        assertion.message ??
        (assertion.pass ? 'Custom assertion passed' : 'Custom assertion failed'),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      pass: false,
      score: 0,
      message: `Custom assertion threw: ${message}`,
    };
  }
}

/**
 * Determines the appropriate matcher for an evaluation case and applies it
 * against the run result. Handles string, RegExp, SemanticMatcher, and custom
 * assertion functions.
 */
export async function matchOutput(
  runResult: RunResult,
  evaluationCase: EvaluationCase,
  embedder?: EmbedderFunction,
): Promise<MatchResult> {
  const { expectedOutput } = evaluationCase;

  if (expectedOutput !== undefined) {
    if (typeof expectedOutput === 'string') {
      return matchExact(runResult.content, expectedOutput);
    }

    if (expectedOutput instanceof RegExp) {
      return matchRegex(runResult.content, expectedOutput);
    }

    if (expectedOutput.type === 'semantic') {
      return matchSemantic(runResult.content, expectedOutput, embedder);
    }
  }

  if (evaluationCase.assert) {
    return matchCustomAssertion(runResult, evaluationCase.assert);
  }

  // No output expectation and no custom assertion — pass by default
  return {
    pass: true,
    score: 1,
    message: 'No output expectation defined; case passed by default',
  };
}
