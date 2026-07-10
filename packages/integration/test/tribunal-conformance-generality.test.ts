/**
 * AB-99 — Tribunal runner conformance harness (generality + per-role output
 * + SIGTERM partial result).
 *
 * Three things live here that don't fit the single-provider core file:
 *
 * 1. A "webhook event handler"-shaped run — arbitrary instructions, no PR/
 *    diff context, no review-specific tools — proving Phase-Two generalized
 *    runs (not just PR review) are first-class on the same primitives.
 * 2. A non-`specialist` role (`triage`) with its own AB-95 raw-JSON-Schema
 *    output contract, validated against Tribunal's `triageDecisionSchema`.
 * 3. The AB-96 SIGTERM partial-report path — `bureau`'s shipped
 *    `getRunReport()` helper, called synchronously right after `abortRun()`,
 *    exactly the "kill mid-step, still get usage + transcript" contract
 *    `run-agent.mjs`'s own `terminateListener` depends on.
 */
import { createTool, createToolbox } from 'armorer';
import { createCodingToolbox } from 'armorer/coding';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { createBureau } from 'bureau';
import { Conversation } from 'conversationalist';
import type { GenerateFunction, Toolbox } from 'operative';
import { createActiveRun, stopWhen } from 'operative';
import type { AnthropicMessageResponse } from 'operative/anthropic';
import { createAnthropicProvider } from 'operative/anthropic';
import { createMockAnthropicClient } from 'operative/providers/test';
import { z } from 'zod';

import { createTribunalFixtureRepo } from './fixtures/tribunal-fixture-repo';
import { buildTribunalRunReport, mapFinishReasonToStatus } from './fixtures/tribunal-run-envelope';
import {
  agentResultSchema,
  mapRunReportToTribunalAgentResult,
  triageDecisionSchema,
  tribunalOutputSchemaForRole,
} from './fixtures/tribunal-schemas';

describe('AB-99 Tribunal conformance — generality (non-PR runs)', () => {
  it('completes a "webhook event handler"-shaped run: arbitrary instructions, no PR context, no review tools', async () => {
    const repo = await createTribunalFixtureRepo();
    try {
      // Only the generic read-only coding toolbox (AB-90) — no
      // get_changed_files/read_base_file/record_finding. Nothing here
      // assumes a pull request exists.
      const toolbox = createToolbox(createCodingToolbox({ root: repo.repositoryPath }));

      const client = createMockAnthropicClient([
        {
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'read-file',
              input: { path: repo.changedFilePath },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 60, output_tokens: 15 },
        },
        {
          content: [
            {
              type: 'text',
              text: 'Deployment webhook processed: widget.ts is present and well-formed.',
            },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 30, output_tokens: 12 },
        },
      ] satisfies AnthropicMessageResponse[]);

      const conversation = new Conversation();
      conversation.appendSystemMessage(
        'You are a webhook event handler. Inspect the repository and summarize what changed. ' +
          'There is no pull request, no reviewer, and no findings to record.',
      );
      conversation.appendUserMessage(
        JSON.stringify({ event: 'deployment.succeeded', repository: 'ab99-fixture' }),
      );

      const activeRun = createActiveRun({
        generate: createAnthropicProvider({ model: 'claude-sonnet-4-20250514', client }),
        toolbox,
        conversation,
        stopWhen: stopWhen.noToolCalls(),
      });

      const result = await activeRun.result;

      expect(result.finishReason).toBe('stop-condition');
      expect(result.content).toContain('Deployment webhook processed');
      expect(result.error).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  });

  it('produces a valid per-role (triage) structured output distinct from the specialist findings contract', async () => {
    const client = createMockAnthropicClient([
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              skip: true,
              reason: 'Change is a comment-only typo fix; no review needed.',
              riskFlags: [],
            }),
          },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 15 },
      },
    ] satisfies AnthropicMessageResponse[]);

    const conversation = new Conversation();
    conversation.appendSystemMessage(
      'You are a Tribunal triage agent. Decide whether this change needs a full review.',
    );
    conversation.appendUserMessage('A comment-only typo fix in README.md.');

    const activeRun = createActiveRun({
      generate: createAnthropicProvider({ model: 'claude-sonnet-4-20250514', client }),
      toolbox: createToolbox([]) as unknown as Toolbox,
      conversation,
      stopWhen: stopWhen.noToolCalls(),
      responseSchema: tribunalOutputSchemaForRole('triage'),
    });

    const result = await activeRun.result;

    expect(result.finishReason).toBe('stop-condition');
    const triage = triageDecisionSchema.parse(result.structuredOutput);
    expect(triage.skip).toBe(true);
    expect(triage.riskFlags).toEqual([]);

    const report = buildTribunalRunReport({
      runId: 'ab99-triage-run',
      status: mapFinishReasonToStatus(result.finishReason),
      finishReason: result.finishReason,
      usage: result.usage,
      structuredOutput: result.structuredOutput,
      transcript: result.conversation.current,
    });
    const agentResult = mapRunReportToTribunalAgentResult(report, {
      agentSlug: 'ab99-triage',
      findings: [],
    });
    const parsed = agentResultSchema.safeParse(agentResult);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.triage?.skip).toBe(true);
    }
  });
});

describe('AB-99 Tribunal conformance — SIGTERM partial result (AB-96)', () => {
  it('bureau.abortRun() + a synchronous bureau.getRunReport() call return usage + transcript accumulated through the last completed step — the terminateListener contract run-agent.mjs relies on', async () => {
    const addTool = createTool({
      name: 'get_changed_files',
      description: 'List changed files.',
      input: z.object({}),
      execute: async () => ({ changedFiles: [{ path: 'src/widget.ts', status: 'modified' }] }),
    });

    let step = 0;
    const generate: GenerateFunction = async () => {
      step += 1;
      if (step === 1) {
        return {
          content: '',
          toolCalls: [{ name: 'get_changed_files', arguments: {} }],
          usage: { prompt: 80, completion: 15, total: 95 },
        };
      }
      // Step 2 hangs — the only way out is SIGTERM/abort, mirroring
      // run-agent.mjs's terminateListener firing mid-generate.
      return new Promise<never>(() => {});
    };

    const bureau = await createBureau({
      generate,
      toolbox: createTestToolbox([addTool]) as unknown as Toolbox,
    });

    try {
      const run = await bureau.createRun({ message: 'Review the changed files.' });

      await new Promise<void>((resolve) => {
        const check = () => {
          const runState = bureau.store.getRun(run.id);
          if (runState && runState.steps.length > 0) resolve();
          else setTimeout(check, 0);
        };
        check();
      });

      bureau.abortRun(run.id);
      // NO await — this is the synchronous graceful-shutdown call a real
      // SIGTERM handler makes right before process exit.
      const partialReport = bureau.getRunReport(run.id);

      expect(partialReport).toBeDefined();
      expect(partialReport?.status).toBe('aborted');
      expect(partialReport?.usage.total).toBeGreaterThan(0);
      expect(partialReport?.transcript).toBeDefined();

      if (partialReport) {
        const agentResult = mapRunReportToTribunalAgentResult(partialReport, {
          agentSlug: 'ab99-sigterm',
          findings: [],
        });
        const parsed = agentResultSchema.safeParse(agentResult);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.stopped).toBe('timeout');
        }
      }
    } finally {
      bureau.dispose();
    }
  });
});
