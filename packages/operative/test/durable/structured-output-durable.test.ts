import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createTestToolbox } from 'armorer/test';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { createCheckpointStore } from '../../src/durable/checkpoint-store';
import { createRunEngine } from '../../src/durable/create-run-engine';
import { resumeDurableRunResult, startDurableRunResult } from '../../src/durable/index';
import {
  AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
  createRunWorkflow,
  normalizeAgentRunWorkflowResult,
} from '../../src/durable/run-workflow';
import { stopWhen } from '../../src/index';
import { UnsupportedRunResultVersionError } from '../../src/run-envelope';

// Drain Weft's deferred inline-launch queue between tests (see other durable
// suites) — a pending setTimeout(0) inline-launch left by one durable run can
// starve a later one under full `bun test` concurrency (CI).
afterEach(async () => {
  await yieldToPortableEventLoop();
});

const answerSchema = z.object({ answer: z.string() });

describe('durable workflow result migration', () => {
  it('rejects a non-object terminal summary at the durable boundary', () => {
    expect(() => normalizeAgentRunWorkflowResult('not a summary')).toThrow(
      'Invalid durable agent run workflow result',
    );
  });

  it('rejects a legacy terminal summary before resumed result reconstruction', () => {
    expect(() =>
      normalizeAgentRunWorkflowResult({
        runId: 'legacy-summary-run',
        steps: 1,
        content: '{"answer":"legacy"}',
        finishReason: 'stop-condition',
        structuredOutput: { answer: 'legacy' },
      }),
    ).toThrow(UnsupportedRunResultVersionError);
  });

  it('rejects an explicitly versioned current summary that still has structuredOutput', () => {
    expect(() =>
      normalizeAgentRunWorkflowResult({
        schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
        runId: 'legacy-summary-run',
        steps: 1,
        content: '{"answer":"legacy"}',
        finishReason: 'stop-condition',
        structuredOutput: { answer: 'legacy' },
      }),
    ).toThrow(UnsupportedRunResultVersionError);
  });

  it('accepts a current terminal summary with output', () => {
    const summary = normalizeAgentRunWorkflowResult({
      schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
      runId: 'legacy-summary-run',
      steps: 1,
      content: '{"answer":"legacy"}',
      finishReason: 'stop-condition',
      output: { answer: 'current' },
    });

    expect(summary.output).toEqual({ answer: 'current' });
    expect('structuredOutput' in summary).toBe(false);
  });

  it('rejects a legacy summary returned by a resumed terminal workflow', async () => {
    await expect(
      resumeDurableRunResult(
        {
          engine: {
            resume: async () => ({
              result: async () => ({
                runId: 'legacy-resumed-run',
                steps: 1,
                content: '{"answer":"legacy"}',
                finishReason: 'stop-condition',
                structuredOutput: { answer: 'legacy' },
              }),
            }),
          } as never,
          checkpointStore: {
            loadCheckpoint: async () => ({
              conversation: null,
              cursor: { totalUsage: {}, lastContent: '{"answer":"legacy"}', schemaAttempts: 0 },
              steps: [],
            }),
          } as never,
        },
        'legacy-resumed-run',
      ),
    ).rejects.toThrow(UnsupportedRunResultVersionError);
  });
});

describe('durable result-only run helpers preserve output (regression PRRT_kwDORvupsc6PvrcT)', () => {
  // `reconstructRunResult` (shared by `startDurableRunResult` and
  // `resumeDurableRunResult`) used to build the returned `RunResult` without
  // `output` at all — only the full lifecycle/finalize path
  // (`driveDurableRun`/`driveReattachedRun`, used by `createDurableActiveRun`
  // and `reattachDurableActiveRun`) carried it through. A preemptable
  // scheduler run driven by the result-only helpers therefore silently lost
  // its validated `responseSchema` output.

  it('startDurableRunResult: a completed run with a responseSchema carries output', async () => {
    const storage = new MemoryStorage();
    const checkpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    const runWorkflow = createRunWorkflow(checkpointStore);
    const { engine } = await createRunEngine({ storage, runWorkflow, recover: false });

    try {
      const result = await startDurableRunResult(
        { engine, checkpointStore },
        {
          runId: 'structured-output-start-run',
          sessionId: 'structured-output-start-run',
          options: {
            generate: async () => ({
              content: JSON.stringify({ answer: 'hi' }),
              toolCalls: [],
            }),
            toolbox: createTestToolbox([]),
            conversation: new Conversation(),
            stopWhen: stopWhen.noToolCalls(),
            responseSchema: answerSchema,
          },
        },
      );

      expect(result.output).toEqual({ answer: 'hi' });
    } finally {
      engine[Symbol.dispose]?.();
    }
  });

  it('NEUTER CHECK: no responseSchema means no output on the same code path', async () => {
    const storage = new MemoryStorage();
    const checkpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    const runWorkflow = createRunWorkflow(checkpointStore);
    const { engine } = await createRunEngine({ storage, runWorkflow, recover: false });

    try {
      const result = await startDurableRunResult(
        { engine, checkpointStore },
        {
          runId: 'structured-output-neuter-run',
          sessionId: 'structured-output-neuter-run',
          options: {
            generate: async () => ({ content: 'plain text', toolCalls: [] }),
            toolbox: createTestToolbox([]),
            conversation: new Conversation(),
            stopWhen: stopWhen.noToolCalls(),
          },
        },
      );

      expect(result.output).toBeUndefined();
    } finally {
      engine[Symbol.dispose]?.();
    }
  });

  it('resumeDurableRunResult: reconstructing a resumed run from its checkpoint carries output', async () => {
    // Mirrors a real preempt→resume: engine 1 starts the run and suspends it
    // (simulating a crash/preemption mid-flight), then a FRESH engine 2 over
    // the SAME storage resumes it via `resumeDurableRunResult` — the actual
    // cross-process shape the scheduler relies on.
    const storage = new MemoryStorage();
    const runId = 'structured-output-resume-run';

    const checkpointStore1 = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    const runWorkflow1 = createRunWorkflow(checkpointStore1);
    const { engine: engine1 } = await createRunEngine({
      storage,
      runWorkflow: runWorkflow1,
      recover: false,
    });

    const handle = await engine1.start(
      'agentRun',
      { runId, sessionId: runId, agentName: '', maximumSteps: undefined },
      {
        id: runId,
        services: {
          options: {
            generate: async () => new Promise<never>(() => {}),
            toolbox: createTestToolbox([]),
            conversation: new Conversation(),
            stopWhen: stopWhen.noToolCalls(),
          },
          toolbox: createTestToolbox([]),
        },
      },
    );
    void (handle as { result: () => Promise<unknown> }).result().catch(() => {});

    let status = await engine1.get(runId);
    while (status?.status !== 'running') {
      await yieldToPortableEventLoop();
      status = await engine1.get(runId);
    }
    await engine1.suspend(runId);
    engine1[Symbol.dispose]?.();

    const checkpointStore2 = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    const runWorkflow2 = createRunWorkflow(checkpointStore2);
    // `resolveWorkflowServices` re-provides the non-serializable RunOptions
    // (generate/toolbox/etc.) on resume — Weft cannot checkpoint functions.
    // This engine's `generate` is the one that actually produces the
    // schema-matching content.
    const { engine: engine2 } = await createRunEngine({
      storage,
      runWorkflow: runWorkflow2,
      recover: false,
      resolveWorkflowServices: () => ({
        status: 'available',
        services: {
          options: {
            generate: async () => ({
              content: JSON.stringify({ answer: 'resumed' }),
              toolCalls: [],
            }),
            toolbox: createTestToolbox([]),
            conversation: new Conversation(),
            stopWhen: stopWhen.noToolCalls(),
            responseSchema: answerSchema,
          },
          toolbox: createTestToolbox([]),
        },
      }),
    });

    try {
      const result = await resumeDurableRunResult(
        { engine: engine2, checkpointStore: checkpointStore2 },
        runId,
      );
      expect(result.output).toEqual({ answer: 'resumed' });
    } finally {
      engine2[Symbol.dispose]?.();
    }
  });
});
