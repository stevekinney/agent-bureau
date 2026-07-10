/**
 * AB-99 — Tribunal runner conformance harness (single-provider core).
 *
 * Replicates `tribunal/runner/run-agent.mjs`'s end-to-end semantics against
 * a real fixture repository and a mocked Anthropic Messages endpoint:
 * cwd-jailed read tools (armorer/coding, AB-90), a Tribunal-shaped armorer
 * toolbox (`get_changed_files`, `read_base_file` via `git show`,
 * `record_finding` with collect-don't-post semantics), AB-94 deny-gate
 * enforcement, AB-95 raw-JSON-Schema structured output, AB-96's NDJSON
 * frame relay + terminal envelope (asserted against a copy of Tribunal's
 * `agentResultSchema`), a budget stop, and AB-98's stable-prefix assembly
 * (verified via observed cache-read behavior on a re-run against the mock).
 *
 * If `/Users/stevekinney/Developer/tribunal` is unreadable in some other
 * environment this suite runs in, the schemas this asserts against
 * (`fixtures/tribunal-schemas.ts`) are still a faithful, dated copy — see
 * that file's header.
 */
import { createHeadlessPermissionPolicyHooks, createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import {
  BudgetExceededError,
  createActiveRun,
  createContextAssembler,
  createCostBudgetMonitor,
  createTokenBudget,
  stopWhen,
} from 'operative';
import type { AnthropicMessageResponse } from 'operative/anthropic';
import { createAnthropicProvider } from 'operative/anthropic';
import { createMockAnthropicClient } from 'operative/providers/test';
import { z } from 'zod';

import { createTribunalFixtureRepo } from './fixtures/tribunal-fixture-repo';
import {
  buildTribunalRunReport,
  captureRunEnvelope,
  finishRunEnvelope,
  mapFinishReasonToStatus,
} from './fixtures/tribunal-run-envelope';
import {
  agentResultSchema,
  mapRunReportToTribunalAgentResult,
  tribunalOutputSchemaForRole,
} from './fixtures/tribunal-schemas';
import {
  createTribunalPermissions,
  createTribunalToolboxFixture,
} from './fixtures/tribunal-toolbox';

function seedConversation(diffSummary: string): Conversation {
  const conversation = new Conversation();
  conversation.appendSystemMessage(
    'You are a Tribunal specialist review agent. Report only confirmed, actionable findings ' +
      'via record_finding. Do not approve, reject, or modify the pull request.',
  );
  conversation.appendUserMessage(diffSummary);
  return conversation;
}

const FINAL_STRUCTURED_TEXT = JSON.stringify({ findings: [] });

describe('AB-99 Tribunal conformance — single provider (Anthropic mock)', () => {
  it("runs a specialist review to completion: tool_use -> record_finding -> structured result, envelope validates against Tribunal's agentResultSchema", async () => {
    const repo = await createTribunalFixtureRepo();
    try {
      const toolboxFixture = createTribunalToolboxFixture({
        repositoryPath: repo.repositoryPath,
        baseSha: repo.baseSha,
        headSha: repo.headSha,
        changedFiles: [{ path: repo.changedFilePath, status: 'modified' }],
      });
      const gatedToolbox = createToolbox(toolboxFixture.tools, {
        policy: createHeadlessPermissionPolicyHooks(
          createTribunalPermissions(toolboxFixture.allowedToolNames),
        ),
      });

      const client = createMockAnthropicClient([
        {
          content: [{ type: 'tool_use', id: 'call_1', name: 'get_changed_files', input: {} }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 120, output_tokens: 18 },
        },
        {
          content: [
            {
              type: 'tool_use',
              id: 'call_2',
              name: 'record_finding',
              input: {
                finding: {
                  path: repo.changedFilePath,
                  startLine: 3,
                  endLine: 3,
                  side: 'RIGHT',
                  severity: 'warning',
                  title: 'Silent coercion of non-finite input',
                  body: '`a + b || 0` masks NaN/undefined instead of validating the input.',
                },
              },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 140, output_tokens: 40 },
        },
        {
          content: [{ type: 'text', text: FINAL_STRUCTURED_TEXT }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 90, output_tokens: 12 },
        },
      ] satisfies AnthropicMessageResponse[]);

      const generate = createAnthropicProvider({
        model: 'claude-sonnet-4-20250514',
        client,
      });

      const runId = 'ab99-specialist-run';
      const activeRun = createActiveRun({
        generate,
        toolbox: gatedToolbox,
        conversation: seedConversation(
          `PR touches ${repo.changedFilePath}. Review the change for confirmed, actionable findings.`,
        ),
        stopWhen: stopWhen.noToolCalls(),
        responseSchema: tribunalOutputSchemaForRole('specialist'),
      });

      const envelope = captureRunEnvelope(runId, activeRun);
      const result = await activeRun.result;
      envelope.dispose();

      expect(result.finishReason).toBe('stop-condition');
      expect(toolboxFixture.collectedFindings).toHaveLength(1);
      expect(toolboxFixture.collectedFindings[0]?.title).toBe(
        'Silent coercion of non-finite input',
      );

      // NDJSON frame relay: every line parses, and the expected sequence is
      // present in order — run-started, tool-pre/tool-post pairs, and (once
      // appended below) run-finished.
      for (const line of envelope.lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(envelope.frames[0]?.type).toBe('run-started');
      const toolPreFrames = envelope.frames.filter((frame) => frame.type === 'tool-pre');
      const toolPostFrames = envelope.frames.filter((frame) => frame.type === 'tool-post');
      expect(toolPreFrames).toHaveLength(2);
      expect(toolPostFrames).toHaveLength(2);
      expect(
        toolPostFrames.every((frame) => frame.type === 'tool-post' && frame.status === 'success'),
      ).toBe(true);

      // Pulled from the last step's GenerateResponse.metadata (AB-91's
      // effective-value reporting), not hardcoded — this is what actually
      // reaches a real RunReport, including the literal `'none'` sentinel
      // the Anthropic/OpenAI adapters set for `effectiveEffort` when no
      // effort option was supplied.
      const lastStepMetadata = result.steps.at(-1)?.metadata;
      const report = buildTribunalRunReport({
        runId,
        status: mapFinishReasonToStatus(result.finishReason),
        finishReason: result.finishReason,
        usage: result.usage,
        costEstimate: result.costEstimate,
        effectiveModel:
          typeof lastStepMetadata?.['effectiveModel'] === 'string'
            ? lastStepMetadata['effectiveModel']
            : undefined,
        effectiveEffort:
          typeof lastStepMetadata?.['effectiveEffort'] === 'string'
            ? lastStepMetadata['effectiveEffort']
            : undefined,
        structuredOutput: result.structuredOutput,
        transcript: result.conversation.current,
      });

      // The 'none' sentinel must never leak into Tribunal's agentResult —
      // mapRunReportToTribunalAgentResult normalizes it to null.
      expect(report.effectiveEffort).toBe('none');

      // Append the terminal `run-finished` frame via the same AB-96
      // constructor the mid-run frames used, then confirm the FULL NDJSON
      // stream — run-started through run-finished — round-trips JSON, the
      // line-protocol contract `run-agent.mjs`'s stdout depends on.
      finishRunEnvelope(envelope, runId, report);
      for (const line of envelope.lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(envelope.frames.at(-1)?.type).toBe('run-finished');

      const agentResult = mapRunReportToTribunalAgentResult(report, {
        agentSlug: 'ab99-specialist',
        findings: toolboxFixture.collectedFindings,
      });
      const parsed = agentResultSchema.safeParse(agentResult);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.findings).toHaveLength(1);
        expect(parsed.data.usage.inputTokens).toBeGreaterThan(0);
        // Without the 'none' -> null normalization this assertion is what
        // would fail: agentResultSchema.effortUsed only accepts the real
        // effort enum or null, never the literal string 'none'.
        expect(parsed.data.effortUsed).toBeNull();
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('AB-94 deny-gate: a tool call outside the allowlist is denied, not executed, and the run continues', async () => {
    const repo = await createTribunalFixtureRepo();
    try {
      const toolboxFixture = createTribunalToolboxFixture({
        repositoryPath: repo.repositoryPath,
        baseSha: repo.baseSha,
        headSha: repo.headSha,
        changedFiles: [{ path: repo.changedFilePath, status: 'modified' }],
      });
      // A tool NOT on the review toolbox — stands in for a `bash`/`write`
      // call an over-eager model might attempt.
      const bashTool = createTool({
        name: 'bash',
        description: 'Execute an arbitrary shell command.',
        input: z.object({ command: z.string() }),
        execute: async () => 'should never run',
      });

      const gatedToolbox = createToolbox([...toolboxFixture.tools, bashTool], {
        policy: createHeadlessPermissionPolicyHooks(
          createTribunalPermissions(toolboxFixture.allowedToolNames),
        ),
      });

      const client = createMockAnthropicClient([
        {
          content: [
            { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'rm -rf /' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 10 },
        },
        {
          content: [{ type: 'text', text: FINAL_STRUCTURED_TEXT }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 40, output_tokens: 8 },
        },
      ] satisfies AnthropicMessageResponse[]);

      const activeRun = createActiveRun({
        generate: createAnthropicProvider({ model: 'claude-sonnet-4-20250514', client }),
        toolbox: gatedToolbox,
        conversation: seedConversation('Review the change.'),
        stopWhen: stopWhen.noToolCalls(),
        responseSchema: tribunalOutputSchemaForRole('specialist'),
      });

      const envelope = captureRunEnvelope('ab99-deny-gate-run', activeRun);
      const result = await activeRun.result;
      envelope.dispose();

      expect(result.finishReason).toBe('stop-condition');
      const denialFrame = envelope.frames.find(
        (frame) => frame.type === 'tool-post' && frame.toolName === 'bash',
      );
      expect(denialFrame).toBeDefined();
      if (denialFrame?.type === 'tool-post') {
        expect(denialFrame.status).toBe('denied');
        expect(denialFrame.error).toContain('not on the headless permission policy');
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('budget stop: createCostBudgetMonitor halts the run once the configured budget is exceeded', async () => {
    const repo = await createTribunalFixtureRepo();
    try {
      const toolboxFixture = createTribunalToolboxFixture({
        repositoryPath: repo.repositoryPath,
        baseSha: repo.baseSha,
        headSha: repo.headSha,
        changedFiles: [{ path: repo.changedFilePath, status: 'modified' }],
      });
      const toolbox = createToolbox(toolboxFixture.tools);

      // Every step returns another tool_use with a large token usage, so the
      // budget monitor's stopCondition fires well before the model ever
      // emits a final answer — proves the STOP is budget-driven, not the
      // no-tool-calls condition.
      const responses: AnthropicMessageResponse[] = Array.from({ length: 10 }, (_, index) => ({
        content: [{ type: 'tool_use', id: `call_${index}`, name: 'get_changed_files', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50_000, output_tokens: 5_000 },
      }));
      const client = createMockAnthropicClient(responses);

      // `createCostBudgetMonitor`'s `stopCondition` alone only produces a
      // generic `stop-condition` finish reason (it's a plain predicate, like
      // any other `StopCondition`). A genuine `'budget-exceeded'` finish
      // reason — the one `mapFinishReasonToStatus` maps to `budget_stopped`
      // — comes from a THROWN `BudgetExceededError` (`run-lifecycle.ts`'s
      // `makeErrorResult`), so `onExceeded` throws it here.
      const budgetMonitor = createCostBudgetMonitor({
        budget: 0.01,
        model: 'claude-sonnet-4-20250514',
        onExceeded: (event) => {
          throw new BudgetExceededError(
            `Cost budget exceeded (${event.currentCost} of ${event.budget})`,
          );
        },
      });

      const activeRun = createActiveRun({
        generate: createAnthropicProvider({ model: 'claude-sonnet-4-20250514', client }),
        toolbox,
        conversation: seedConversation('Review the change.'),
        stopWhen: [stopWhen.noToolCalls(), budgetMonitor.stopCondition],
        maximumSteps: 10,
      });

      const result = await activeRun.result;

      expect(result.finishReason).toBe('budget-exceeded');
      expect(budgetMonitor.currentCost).toBeGreaterThanOrEqual(0.01);

      const report = buildTribunalRunReport({
        runId: 'ab99-budget-run',
        status: mapFinishReasonToStatus(result.finishReason),
        finishReason: result.finishReason,
        usage: result.usage,
        costEstimate: result.costEstimate,
        transcript: result.conversation.current,
      });
      expect(report.status).toBe('budget_stopped');
    } finally {
      await repo.cleanup();
    }
  });

  it('AB-98 stable-prefix assembly: a re-run against the same mock endpoint observes cache-read usage and an unchanged request prefix', async () => {
    const repo = await createTribunalFixtureRepo();
    try {
      const toolboxFixture = createTribunalToolboxFixture({
        repositoryPath: repo.repositoryPath,
        baseSha: repo.baseSha,
        headSha: repo.headSha,
        changedFiles: [{ path: repo.changedFilePath, status: 'modified' }],
      });
      const toolbox = createToolbox(toolboxFixture.tools);

      // Step 0: cold — no cache hit yet (this is the write that populates
      // the cache). Step 1: the SAME stable system/tool prefix is
      // re-assembled, and the mock reports a cache read for it.
      const client = createMockAnthropicClient([
        {
          content: [{ type: 'tool_use', id: 'call_1', name: 'get_changed_files', input: {} }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 500, output_tokens: 20, cache_creation_input_tokens: 480 },
        },
        {
          content: [{ type: 'text', text: FINAL_STRUCTURED_TEXT }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 12, cache_read_input_tokens: 480 },
        },
      ] satisfies AnthropicMessageResponse[]);

      const generate = createAnthropicProvider({
        model: 'claude-sonnet-4-20250514',
        client,
        assembler: createContextAssembler(),
        contextBudget: createTokenBudget({ maxTokens: 100_000 }),
      });

      const activeRun = createActiveRun({
        generate,
        toolbox,
        conversation: seedConversation('Review the change.'),
        stopWhen: stopWhen.noToolCalls(),
      });

      const result = await activeRun.result;

      expect(client._calls).toHaveLength(2);
      // Stable prefix: the system content assembled for step 0 and step 1
      // is byte-identical — the ONLY thing that grew between calls was the
      // tail (the tool result), not the cached prefix.
      expect(client._calls[0]?.['system']).toEqual(client._calls[1]?.['system']);

      // The discriminating check: the assembled request must actually carry
      // an Anthropic `cache_control` breakpoint on the stable prefix — not
      // just a mock that happens to report cache-read usage regardless of
      // what was sent. Without a real breakpoint in the request, a real
      // Anthropic endpoint would never populate `cache_read_input_tokens`
      // in the first place, so this is what makes the usage assertion below
      // mean something instead of testing the mock's own echo.
      const system = client._calls[0]?.['system'];
      expect(Array.isArray(system)).toBe(true);
      const systemBlocks = system as Array<Record<string, unknown>>;
      expect(
        systemBlocks.some(
          (block) => typeof block['cache_control'] === 'object' && block['cache_control'] !== null,
        ),
      ).toBe(true);

      expect(result.usage.cacheReadTokens ?? 0).toBeGreaterThan(0);
    } finally {
      await repo.cleanup();
    }
  });
});
