import type { RunResult } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { createAgentCatalog } from './agent-catalog';
import { createSupervisor } from './create-supervisor';
import { TaskCompletedEvent, TaskFailedEvent } from './supervisor-contracts';
import {
  makeAgent,
  makeFailedRunResult,
  makeMalformedRunResult,
  makeRunResult,
  requireError,
} from './supervisor-test-helpers';
describe('createSupervisor', () => {
  describe('failed agent RunResult', () => {
    const FAILURE_REASONS: RunResult['finishReason'][] = [
      'error',
      'aborted',
      'budget-exceeded',
      'elicitation-denied',
      'tripwire',
    ];

    for (const reason of FAILURE_REASONS) {
      it(`dispatches TaskFailedEvent (not TaskCompletedEvent) when finishReason is "${reason}"`, async () => {
        const originalError = new Error(`agent failed: ${reason}`);
        const worker = makeAgent('worker', () =>
          Promise.resolve(makeFailedRunResult(reason, originalError)),
        );
        const catalog = createAgentCatalog({ worker: worker.fixture });
        const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

        const completedEvents: TaskCompletedEvent[] = [];
        const failedEvents: TaskFailedEvent[] = [];
        supervisor.addEventListener(TaskCompletedEvent.type, (e) => completedEvents.push(e));
        supervisor.addEventListener(TaskFailedEvent.type, (e) => failedEvents.push(e));

        const result = await supervisor.delegate('do something');

        expect(failedEvents).toHaveLength(1);
        expect(completedEvents).toHaveLength(0);

        const agentResult = result.agentResults[0];
        expect(agentResult?.error).toBe(originalError);
        expect(agentResult?.result?.finishReason).toBe(reason);
      });
    }

    it('surfaces a synthetic Error when RunResult has a failure reason but no .error property', async () => {
      const worker = makeAgent('worker', () =>
        Promise.resolve(makeFailedRunResult('budget-exceeded')),
      );
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const result = await supervisor.delegate('do something');
      const agentResult = result.agentResults[0];
      expect(agentResult?.error).toBeInstanceOf(Error);
      expect(requireError(agentResult?.error).message).toContain('budget-exceeded');
    });

    it('includes the failure in the default synthesis output', async () => {
      const worker = makeAgent('worker', () =>
        Promise.resolve(makeFailedRunResult('error', new Error('something broke'))),
      );
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const result = await supervisor.delegate('do something');
      expect(result.synthesis).toContain('Error:');
      expect(result.synthesis).toContain('something broke');
    });

    it('does not short-circuit for stop-condition (success)', async () => {
      const worker = makeAgent('worker', () =>
        Promise.resolve(makeRunResult('all done', 'stop-condition')),
      );
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const completedEvents: TaskCompletedEvent[] = [];
      const failedEvents: TaskFailedEvent[] = [];
      supervisor.addEventListener(TaskCompletedEvent.type, (e) => completedEvents.push(e));
      supervisor.addEventListener(TaskFailedEvent.type, (e) => failedEvents.push(e));

      const result = await supervisor.delegate('do something');
      expect(completedEvents).toHaveLength(1);
      expect(failedEvents).toHaveLength(0);
      expect(result.agentResults[0]?.error).toBeUndefined();
    });

    it('does not treat maximum-steps as a failure', async () => {
      const worker = makeAgent('worker', () =>
        Promise.resolve(makeRunResult('partial output', 'maximum-steps')),
      );
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const completedEvents: TaskCompletedEvent[] = [];
      const failedEvents: TaskFailedEvent[] = [];
      supervisor.addEventListener(TaskCompletedEvent.type, (e) => completedEvents.push(e));
      supervisor.addEventListener(TaskFailedEvent.type, (e) => failedEvents.push(e));

      const result = await supervisor.delegate('do something');
      expect(completedEvents).toHaveLength(1);
      expect(failedEvents).toHaveLength(0);
      expect(result.agentResults[0]?.error).toBeUndefined();
    });

    it('reports a failure (not a synthesized success) when the agent handle resolves to a structurally incomplete result (PRRT_kwDORvupsc6elFWQ)', async () => {
      // A hand-written or JavaScript catalog agent can resolve to any value;
      // `{}` has no finishReason, so the predecessor cast let it fall
      // through `isFailureResult` (reading `undefined.finishReason` as
      // falsy) and be dispatched as a TaskCompletedEvent.
      const worker = makeAgent(
        'worker',
        () => Promise.resolve(makeMalformedRunResult()), // structurally incomplete
      );
      const catalog = createAgentCatalog({ worker: worker.fixture });
      const supervisor = createSupervisor({ agents: catalog, routing: () => 'worker' });

      const completedEvents: TaskCompletedEvent[] = [];
      const failedEvents: TaskFailedEvent[] = [];
      supervisor.addEventListener(TaskCompletedEvent.type, (e) => completedEvents.push(e));
      supervisor.addEventListener(TaskFailedEvent.type, (e) => failedEvents.push(e));

      const result = await supervisor.delegate('do something');

      expect(completedEvents).toHaveLength(0);
      expect(failedEvents).toHaveLength(1);
      const agentResult = result.agentResults[0];
      expect(agentResult?.error).toBeInstanceOf(Error);
      expect(requireError(agentResult?.error).message).toMatch(/not a RunResult/i);
      expect(agentResult?.result).toBeUndefined();
    });
  });
});
