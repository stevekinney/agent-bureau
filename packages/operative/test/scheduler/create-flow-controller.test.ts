import { describe, expect, it } from 'bun:test';

import type { FlowControlTrigger } from '../../src/scheduler/create-flow-controller';
import { createFlowController } from '../../src/scheduler/create-flow-controller';

function trigger(overrides: Partial<FlowControlTrigger> = {}): FlowControlTrigger {
  return {
    runId: `run-${Math.random().toString(36).slice(2)}`,
    agentName: 'support-agent',
    source: 'api',
    message: 'hello',
    ...overrides,
  };
}

describe('createFlowController', () => {
  describe('concurrency', () => {
    it('admits up to the configured cap and rejects the next admission', () => {
      const controller = createFlowController({ concurrency: { limit: 2 } });

      const first = controller.admit(trigger({ runId: 'run-1' }));
      const second = controller.admit(trigger({ runId: 'run-2' }));
      const third = controller.admit(trigger({ runId: 'run-3' }));

      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);
      expect(third).toEqual({ allowed: false, reason: 'concurrency' });

      controller.settle('run-1');
      expect(controller.admit(trigger({ runId: 'run-4' })).allowed).toBe(true);
    });

    it('frees a slot once a run settles, admitting the next trigger', () => {
      const controller = createFlowController({ concurrency: { limit: 1 } });

      controller.admit(trigger({ runId: 'run-1' }));
      const rejected = controller.admit(trigger({ runId: 'run-2' }));
      expect(rejected.allowed).toBe(false);

      controller.settle('run-1');

      const admitted = controller.admit(trigger({ runId: 'run-2' }));
      expect(admitted.allowed).toBe(true);
    });

    it('isolates the cap per agent by default', () => {
      const controller = createFlowController({ concurrency: { limit: 1 } });

      const first = controller.admit(trigger({ runId: 'run-1', agentName: 'agent-a' }));
      const second = controller.admit(trigger({ runId: 'run-2', agentName: 'agent-b' }));
      const third = controller.admit(trigger({ runId: 'run-3', agentName: 'agent-a' }));

      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);
      expect(third).toEqual({ allowed: false, reason: 'concurrency' });
    });

    it('isolates the cap per an arbitrary key function', () => {
      const controller = createFlowController({
        concurrency: { limit: 1, key: (t) => t.metadata?.['tenant'] as string },
      });

      const first = controller.admit(trigger({ runId: 'run-1', metadata: { tenant: 'acme' } }));
      const second = controller.admit(trigger({ runId: 'run-2', metadata: { tenant: 'globex' } }));
      const third = controller.admit(trigger({ runId: 'run-3', metadata: { tenant: 'acme' } }));

      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);
      expect(third).toEqual({ allowed: false, reason: 'concurrency' });
    });

    it('NEUTER-VERIFIED: a parked run frees its slot for a new admission, and markResumed reclaims it', () => {
      const controller = createFlowController({ concurrency: { limit: 1 } });

      controller.admit(trigger({ runId: 'run-1' }));
      expect(controller.admit(trigger({ runId: 'run-2' })).allowed).toBe(false);

      controller.markParked('run-1');

      // The slot freed by the park is what makes this succeed. Neutering
      // markParked into a no-op (verified below) makes this assertion fail,
      // proving the test actually exercises the park-frees-slot behavior.
      const admittedWhileParked = controller.admit(trigger({ runId: 'run-2' }));
      expect(admittedWhileParked.allowed).toBe(true);

      // run-1 resumes and reclaims a slot; run-3 now finds the cap full again.
      controller.markResumed('run-1');
      const rejectedAfterResume = controller.admit(trigger({ runId: 'run-3' }));
      expect(rejectedAfterResume).toEqual({ allowed: false, reason: 'concurrency' });
    });

    it('is unaffected by markParked/markResumed for a run with no held slot', () => {
      const controller = createFlowController({ concurrency: { limit: 1 } });
      // Neither call should throw or affect state for an unknown runId.
      controller.markParked('unknown');
      controller.markResumed('unknown');
      expect(controller.admit(trigger({ runId: 'run-1' })).allowed).toBe(true);
    });
  });

  describe('rateLimit', () => {
    it('caps admissions within the window and recovers once the window slides', () => {
      let now = 0;
      const controller = createFlowController(
        { rateLimit: { limit: 2, windowMilliseconds: 1000 } },
        { now: () => now },
      );

      expect(controller.admit(trigger({ runId: 'run-1' })).allowed).toBe(true);
      expect(controller.admit(trigger({ runId: 'run-2' })).allowed).toBe(true);
      expect(controller.admit(trigger({ runId: 'run-3' }))).toEqual({
        allowed: false,
        reason: 'rate-limit',
      });

      now = 1001;
      expect(controller.admit(trigger({ runId: 'run-4' })).allowed).toBe(true);
    });

    it('is not released by settle — only the sliding window recovers it', () => {
      const now = 0;
      const controller = createFlowController(
        { rateLimit: { limit: 1, windowMilliseconds: 1000 } },
        { now: () => now },
      );

      controller.admit(trigger({ runId: 'run-1' }));
      controller.settle('run-1');

      expect(controller.admit(trigger({ runId: 'run-2' }))).toEqual({
        allowed: false,
        reason: 'rate-limit',
      });
    });

    it('isolates limits per an arbitrary key function', () => {
      const now = 0;
      const controller = createFlowController(
        {
          rateLimit: {
            limit: 1,
            windowMilliseconds: 1000,
            key: (t) => t.principal ?? 'anonymous',
          },
        },
        { now: () => now },
      );

      const first = controller.admit(trigger({ runId: 'run-1', principal: 'alice' }));
      const second = controller.admit(trigger({ runId: 'run-2', principal: 'bob' }));
      const third = controller.admit(trigger({ runId: 'run-3', principal: 'alice' }));

      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);
      expect(third).toEqual({ allowed: false, reason: 'rate-limit' });
    });
  });

  describe('singleton', () => {
    it('dedupes a concurrent identical trigger by key', () => {
      const controller = createFlowController({
        singleton: { key: (t) => `${t.agentName}:${t.sessionId}` },
      });

      const first = controller.admit(trigger({ runId: 'run-1', sessionId: 'session-a' }));
      const second = controller.admit(trigger({ runId: 'run-2', sessionId: 'session-a' }));
      const third = controller.admit(trigger({ runId: 'run-3', sessionId: 'session-b' }));

      expect(first.allowed).toBe(true);
      expect(second).toEqual({ allowed: false, reason: 'singleton' });
      expect(third.allowed).toBe(true);
    });

    it('releases the key once the run settles, admitting a fresh trigger with the same key', () => {
      const controller = createFlowController({
        singleton: { key: (t) => t.sessionId ?? 'none' },
      });

      controller.admit(trigger({ runId: 'run-1', sessionId: 'session-a' }));
      expect(controller.admit(trigger({ runId: 'run-2', sessionId: 'session-a' })).allowed).toBe(
        false,
      );

      controller.settle('run-1');

      expect(controller.admit(trigger({ runId: 'run-2', sessionId: 'session-a' })).allowed).toBe(
        true,
      );
    });

    it('holds the claim across a park/resume cycle — a duplicate arriving while parked still dedupes', () => {
      const controller = createFlowController({
        singleton: { key: (t) => t.sessionId ?? 'none' },
      });

      controller.admit(trigger({ runId: 'run-1', sessionId: 'session-a' }));
      controller.markParked('run-1');

      const duplicateWhileParked = controller.admit(
        trigger({ runId: 'run-2', sessionId: 'session-a' }),
      );
      expect(duplicateWhileParked).toEqual({ allowed: false, reason: 'singleton' });

      controller.markResumed('run-1');
      controller.settle('run-1');

      expect(controller.admit(trigger({ runId: 'run-2', sessionId: 'session-a' })).allowed).toBe(
        true,
      );
    });
  });

  describe('composed policies', () => {
    it('admits atomically: a concurrency rejection does not consume a rate-limit token', () => {
      const controller = createFlowController({
        rateLimit: { limit: 2, windowMilliseconds: 1000 },
        concurrency: { limit: 1 },
      });

      expect(controller.admit(trigger({ runId: 'run-1' })).allowed).toBe(true);

      // Rejected on concurrency (the cap is full). If admission were not
      // atomic, this attempt would have already spent the second (and last)
      // rate-limit token before the concurrency check ran.
      expect(controller.admit(trigger({ runId: 'run-2' }))).toEqual({
        allowed: false,
        reason: 'concurrency',
      });

      controller.settle('run-1');

      // The rate limiter still has its second token available — proving
      // run-2's rejected attempt did not consume one.
      expect(controller.admit(trigger({ runId: 'run-3' })).allowed).toBe(true);
      expect(controller.admit(trigger({ runId: 'run-4' }))).toEqual({
        allowed: false,
        reason: 'rate-limit',
      });
    });
  });
});
