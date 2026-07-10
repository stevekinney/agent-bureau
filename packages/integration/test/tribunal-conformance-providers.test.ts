/**
 * AB-99 — Tribunal runner conformance harness (two-provider parity).
 *
 * The SAME agent definition — same Tribunal-shaped toolbox, same AB-94
 * headless permission gate, same AB-95 raw-JSON-Schema structured output —
 * run against two independent provider adapters (Anthropic-mock and
 * OpenAI-mock). Only the `generate: GenerateFunction` swaps; every other
 * option is shared between the two runs, proving `RunOptions` genuinely
 * abstracts over the provider.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import type { GenerateFunction } from 'operative';
import { createActiveRun, stopWhen } from 'operative';
import type { AnthropicMessageResponse } from 'operative/anthropic';
import { createAnthropicProvider } from 'operative/anthropic';
import type { OpenAIChatCompletion } from 'operative/openai';
import { createOpenAIProvider } from 'operative/openai';
import { createMockAnthropicClient, createMockOpenAIClient } from 'operative/providers/test';

import { createTribunalFixtureRepo } from './fixtures/tribunal-fixture-repo';
import { buildTribunalRunReport, mapFinishReasonToStatus } from './fixtures/tribunal-run-envelope';
import {
  agentResultSchema,
  mapRunReportToTribunalAgentResult,
  tribunalOutputSchemaForRole,
} from './fixtures/tribunal-schemas';
import {
  createTribunalToolboxFixture,
  type TribunalToolboxFixture,
} from './fixtures/tribunal-toolbox';

const FINDING = {
  path: 'src/widget.ts',
  startLine: 3,
  endLine: 3,
  side: 'RIGHT' as const,
  severity: 'warning' as const,
  title: 'Silent coercion of non-finite input',
  body: '`a + b || 0` masks NaN/undefined instead of validating the input.',
};

function seedConversation(): Conversation {
  const conversation = new Conversation();
  conversation.appendSystemMessage(
    'You are a Tribunal specialist review agent. Report only confirmed, actionable findings ' +
      'via record_finding. Do not approve, reject, or modify the pull request.',
  );
  conversation.appendUserMessage('Review the change and record any confirmed findings.');
  return conversation;
}

function buildAnthropicGenerate(): GenerateFunction {
  const client = createMockAnthropicClient([
    {
      content: [
        { type: 'tool_use', id: 'call_1', name: 'record_finding', input: { finding: FINDING } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 30 },
    },
    {
      content: [{ type: 'text', text: JSON.stringify({ findings: [] }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 40, output_tokens: 10 },
    },
  ] satisfies AnthropicMessageResponse[]);
  return createAnthropicProvider({ model: 'claude-sonnet-4-20250514', client });
}

function buildOpenAIGenerate(): GenerateFunction {
  const client = createMockOpenAIClient([
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'record_finding',
                  arguments: JSON.stringify({ finding: FINDING }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    },
    {
      choices: [
        {
          message: { content: JSON.stringify({ findings: [] }) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
    },
  ] satisfies OpenAIChatCompletion[]);
  return createOpenAIProvider({ model: 'gpt-4o', client });
}

async function runAgainstProvider(
  toolboxFixture: TribunalToolboxFixture,
  generate: GenerateFunction,
  effectiveModel: string,
) {
  const toolbox = createToolbox(toolboxFixture.tools);
  const activeRun = createActiveRun({
    generate,
    toolbox,
    conversation: seedConversation(),
    stopWhen: stopWhen.noToolCalls(),
    responseSchema: tribunalOutputSchemaForRole('specialist'),
  });

  const result = await activeRun.result;
  const report = buildTribunalRunReport({
    runId: `ab99-provider-parity-${effectiveModel}`,
    status: mapFinishReasonToStatus(result.finishReason),
    finishReason: result.finishReason,
    usage: result.usage,
    costEstimate: result.costEstimate,
    effectiveModel,
    structuredOutput: result.structuredOutput,
    transcript: result.conversation.current,
  });

  return { result, report };
}

describe('AB-99 Tribunal conformance — two-provider parity', () => {
  it('produces an equivalent, schema-valid agentResult from the SAME agent definition against Anthropic and OpenAI', async () => {
    const repo = await createTribunalFixtureRepo();
    try {
      const diffContext = {
        repositoryPath: repo.repositoryPath,
        baseSha: repo.baseSha,
        headSha: repo.headSha,
        changedFiles: [{ path: repo.changedFilePath, status: 'modified' as const }],
      };

      const anthropicToolbox = createTribunalToolboxFixture(diffContext);
      const openaiToolbox = createTribunalToolboxFixture(diffContext);

      const [anthropicRun, openaiRun] = await Promise.all([
        runAgainstProvider(anthropicToolbox, buildAnthropicGenerate(), 'claude-sonnet-4-20250514'),
        runAgainstProvider(openaiToolbox, buildOpenAIGenerate(), 'gpt-4o'),
      ]);

      for (const [run, toolboxFixture, agentSlug] of [
        [anthropicRun, anthropicToolbox, 'ab99-anthropic'] as const,
        [openaiRun, openaiToolbox, 'ab99-openai'] as const,
      ]) {
        expect(run.result.finishReason).toBe('stop-condition');
        expect(toolboxFixture.collectedFindings).toHaveLength(1);
        expect(toolboxFixture.collectedFindings[0]?.title).toBe(FINDING.title);

        const agentResult = mapRunReportToTribunalAgentResult(run.report, {
          agentSlug,
          findings: toolboxFixture.collectedFindings,
        });
        const parsed = agentResultSchema.safeParse(agentResult);
        expect(parsed.success).toBe(true);
      }

      // Provider config (client + model) is the ONLY thing that differed —
      // both runs collected the identical finding via the identical tool
      // definition and the identical AB-95 response schema.
      expect(anthropicToolbox.collectedFindings).toEqual(openaiToolbox.collectedFindings);
    } finally {
      await repo.cleanup();
    }
  });
});
