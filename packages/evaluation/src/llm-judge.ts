import type { ToolboxEntries } from 'armorer';
import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

import type { LLMJudgeOptions, LLMJudgeResult } from './types';

const DEFAULT_SCALE = { min: 1, max: 5 };

/**
 * Builds the system prompt for the LLM judge, embedding the rubric and scale.
 */
function buildJudgeSystemPrompt(rubric: string, scale: { min: number; max: number }): string {
  return [
    'You are an evaluation judge. Your task is to score the quality of an AI assistant response.',
    '',
    `Rubric: ${rubric}`,
    '',
    `Score the response on a scale from ${scale.min} to ${scale.max}.`,
    '',
    'Respond with ONLY a JSON object containing exactly two fields:',
    '- "score": a number within the scale',
    '- "reasoning": a brief explanation of your score',
    '',
    'Example response:',
    `{"score": ${Math.round((scale.min + scale.max) / 2)}, "reasoning": "The response was adequate but lacked detail."}`,
  ].join('\n');
}

/**
 * Builds the user message for the judge, including the input, output, and optional reference.
 */
function buildJudgeUserMessage(input: string, output: string, reference?: string): string {
  const parts = [`Input: ${input}`, '', `Output: ${output}`];

  if (reference) {
    parts.push('', `Reference answer: ${reference}`);
  }

  return parts.join('\n');
}

/**
 * Parses the judge's response, extracting score and reasoning from JSON.
 */
function parseJudgeResponse(content: string, scale: { min: number; max: number }): LLMJudgeResult {
  // Try to extract a JSON object from the response, handling cases where the
  // judge wraps it in markdown code fences or adds extra text. Uses lazy
  // quantifiers (`*?`) to avoid over-matching when the LLM adds commentary
  // after the JSON that contains braces. The regex is order-agnostic — it
  // matches any object containing both keys regardless of which appears first.
  const jsonMatch = content.match(
    /\{[\s\S]*?(?:"score"[\s\S]*?"reasoning"|"reasoning"[\s\S]*?"score")[\s\S]*?\}/,
  );
  const jsonString = jsonMatch ? jsonMatch[0] : content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return {
      score: 0,
      reasoning: `Failed to parse judge response as JSON: ${content}`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      score: 0,
      reasoning: `Judge response was not a JSON object: ${content}`,
    };
  }

  const record = parsed as Record<string, unknown>;

  if (typeof record['score'] !== 'number') {
    return {
      score: 0,
      reasoning: `Judge response missing a numeric "score" field: ${content}`,
    };
  }

  const reasoning = typeof record['reasoning'] === 'string' ? record['reasoning'] : '';

  // Clamp score to the configured scale
  const clampedScore = Math.max(scale.min, Math.min(scale.max, record['score']));

  return { score: clampedScore, reasoning };
}

/**
 * Creates an LLM-as-judge scoring function that evaluates the quality of an
 * AI assistant's output using another LLM with a configurable rubric and scale.
 *
 * The returned function sends a structured prompt to the judge model and parses
 * its JSON response into a score and reasoning. If the judge fails (throws or
 * returns unparseable output), it returns score 0 with an error message.
 *
 * @example
 * ```ts
 * const judge = createLLMJudge({
 *   judge: generateFunction,
 *   rubric: 'Rate factual accuracy and completeness from 1 (poor) to 5 (excellent)',
 * });
 *
 * const { score, reasoning } = await judge(
 *   'What is TypeScript?',
 *   'TypeScript is a typed superset of JavaScript',
 * );
 * ```
 */
export function createLLMJudge(
  options: LLMJudgeOptions,
): (input: string, output: string, reference?: string) => Promise<LLMJudgeResult> {
  const scale = options.scale ?? DEFAULT_SCALE;

  return async (input: string, output: string, reference?: string): Promise<LLMJudgeResult> => {
    try {
      const conversation = new Conversation();
      conversation.appendSystemMessage(buildJudgeSystemPrompt(options.rubric, scale));
      conversation.appendUserMessage(buildJudgeUserMessage(input, output, reference));

      const emptyEntries: ToolboxEntries = [];
      const toolbox = createToolbox(emptyEntries);

      const response = await options.judge({
        conversation,
        step: 1,
        toolbox,
      });

      return parseJudgeResponse(response.content, scale);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        score: 0,
        reasoning: `Judge evaluation failed: ${message}`,
      };
    }
  };
}
