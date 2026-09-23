import {
  AbortAgentRunError,
  createActiveRun,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import {
  buildPartialRunReport,
  buildTerminalReportFromAbortedEvent,
  buildTerminalReportFromCompletedEvent,
} from './run-envelope';

const generateCompletedReport: GenerateFunction = async () => ({
  content: 'Done.',
  toolCalls: [],
  usage: { prompt: 10, completion: 5, total: 15 },
  metadata: { effectiveModel: 'claude-sonnet-5', effectiveEffort: 'medium' },
});

describe('buildTerminalReportFromCompletedEvent / buildTerminalReportFromAbortedEvent', () => {
  it('builds a succeeded report with usage, costEstimate, and effectiveModel from a completed run', async () => {
    const activeRun = createActiveRun({
      generate: generateCompletedReport,
      toolbox: createToolbox<readonly Tool[]>([]),
      conversation: new Conversation(),
      maximumSteps: 1,
      stopWhen: stopWhen.noToolCalls(),
      runId: 'run-completed-1',
      costEstimation: { model: 'claude-sonnet-5' },
    });

    let captured: Parameters<typeof buildTerminalReportFromCompletedEvent>[1] | undefined;
    activeRun.once('run.completed', (event) => {
      captured = event;
    });

    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');
    expect(captured).toBeDefined();

    const report = buildTerminalReportFromCompletedEvent('run-completed-1', captured!);
    expect(report.status).toBe('succeeded');
    expect(report.usage).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(report.effectiveModel).toBe('claude-sonnet-5');
    expect(report.effectiveEffort).toBe('medium');
    expect(report.transcript?.ids.length).toBeGreaterThan(0);

    const roundTripped: unknown = JSON.parse(JSON.stringify(report));
    expect(roundTripped).toEqual(JSON.parse(JSON.stringify(report)));
  });

  it('builds a budget_stopped report when the run finishes on budget-exceeded', () => {
    // Exercises the mapping/build helper directly against a hand-built event
    // shape (the same fields RunCompletedEvent carries) rather than wiring a
    // full budget monitor through a real run.
    const conversation = new Conversation();
    conversation.appendUserMessage('hi');

    const report = buildTerminalReportFromCompletedEvent('run-budget-1', {
      finishReason: 'budget-exceeded',
      usage: { prompt: 3, completion: 1, total: 4 },
      steps: [],
      conversation,
      error: new Error('budget exceeded'),
    });

    expect(report.status).toBe('budget_stopped');
    expect(report.error).toBe('budget exceeded');
  });

  it('builds an aborted report from a run.aborted event, pulling steps from the store', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('hi');
    conversation.appendAssistantMessage('partial');

    const report = buildTerminalReportFromAbortedEvent('run-aborted-1', {
      usage: { prompt: 4, completion: 2, total: 6 },
      reason: 'user cancelled',
      error: new AbortAgentRunError('user cancelled'),
      steps: [],
      conversation,
    });

    expect(report.status).toBe('aborted');
    expect(report.finishReason).toBe('aborted');
    expect(JSON.parse(report.error ?? '')).toMatchObject({
      name: 'AbortAgentRunError',
      message: 'user cancelled',
      kind: 'abort',
      code: 'ABORTED',
    });
    expect(report.usage).toEqual({ prompt: 4, completion: 2, total: 6 });
    expect(report.transcript?.ids.length).toBeGreaterThan(0);
  });
});

describe('buildPartialRunReport', () => {
  it('synchronously builds a partial aborted report from a live RunState', () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('hi');
    conversation.appendAssistantMessage('working on it', {
      effectiveModel: 'claude-sonnet-5',
      effectiveEffort: 'low',
    });

    const runState = {
      id: 'run-partial-1',
      status: 'running' as const,
      steps: [
        {
          step: 0,
          conversation,
          content: 'working on it',
          toolCalls: [],
          results: [],
          usage: { prompt: 6, completion: 3, total: 9 },
          metadata: { effectiveModel: 'claude-sonnet-5', effectiveEffort: 'low' },
          final: false,
        },
      ],
      usage: { prompt: 6, completion: 3, total: 9 },
      finishReason: undefined,
      error: undefined,
      // The real store (`store.ts`) always pushes a `conversation.snapshot()`
      // alongside every `step.completed` action, in the same reducer update as
      // the step itself — so a genuine RunState never has more steps than
      // snapshots. Mirror that invariant here.
      snapshots: [conversation.snapshot()],
      actions: [],
    };

    const report = buildPartialRunReport('run-partial-1', runState, 'process shutdown');
    expect(report.status).toBe('aborted');
    expect(report.usage).toEqual({ prompt: 6, completion: 3, total: 9 });
    expect(report.effectiveModel).toBe('claude-sonnet-5');
    expect(report.error).toBe('process shutdown');
    expect(report.transcript?.ids.length).toBeGreaterThan(0);
  });

  it('reads the transcript from the last COMPLETED step snapshot, not a later in-flight mutation of the shared Conversation (regression PRRT_kwDORvupsc6PxWjh)', () => {
    // AB-96 codex review: every StepResult.conversation is the SAME mutable
    // Conversation instance the loop threads through every step (see
    // `run-step.ts`). Reading `steps[last].conversation` while a LATER step is
    // still in flight (e.g. it already pushed a tool call but has not yet
    // committed the tool result) would read that dangling, uncommitted state.
    // `buildPartialRunReport` must read the STORE'S OWN immutable snapshot
    // (`runState.snapshots`, captured via `conversation.snapshot()` at each
    // `step.completed`) instead, which freezes the transcript at the moment
    // the step actually finished.
    const conversation = new Conversation();
    conversation.appendUserMessage('hi');
    conversation.appendAssistantMessage('step 0 done', {
      effectiveModel: 'claude-sonnet-5',
      effectiveEffort: 'low',
    });
    // Snapshot taken the instant step 0 completed — this is what a partial
    // report requested right now should reflect.
    const completedSnapshot = conversation.snapshot();

    // Step 1 is now IN FLIGHT on the SAME shared conversation instance: it has
    // pushed a tool call but the tool result has not landed yet (a dangling,
    // uncommitted mutation a partial report must NOT observe).
    conversation.appendToolCall({ id: 'call-1', name: 'search', arguments: {} });

    const runState = {
      id: 'run-partial-dangling',
      status: 'running' as const,
      steps: [
        {
          step: 0,
          // Both entries point at the SAME live, now-further-mutated instance —
          // exactly the shape a real in-memory RunState has.
          conversation,
          content: 'step 0 done',
          toolCalls: [],
          results: [],
          usage: { prompt: 6, completion: 3, total: 9 },
          metadata: { effectiveModel: 'claude-sonnet-5', effectiveEffort: 'low' },
          final: false,
        },
      ],
      usage: { prompt: 6, completion: 3, total: 9 },
      finishReason: undefined,
      error: undefined,
      // Only step 0 ever completed, so only its snapshot was ever captured —
      // the in-flight step 1 mutation has no corresponding snapshot yet.
      snapshots: [completedSnapshot],
      actions: [],
    };

    const report = buildPartialRunReport('run-partial-dangling', runState, 'process shutdown');

    const transcriptMessages = (report.transcript?.ids ?? []).map(
      (id) => report.transcript?.messages[id],
    );

    // The dangling tool call from the in-flight step must NOT appear.
    expect(transcriptMessages.some((message) => message?.toolCall?.id === 'call-1')).toBe(false);
    // The last COMPLETED content must be present.
    expect(transcriptMessages.some((message) => message?.content === 'step 0 done')).toBe(true);
  });
});
