import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { HookRegistry } from 'lifecycle';

import { createChildRunRegistry } from '../child-run';
import { createClosedAcknowledgement } from '../closed-acknowledgement';
import { createTokenBudget } from '../context/token-budget';
import type { OperativeHookMap } from '../hooks';
import { createBarrierRegistry } from './barriers';
import type { Schedule } from './schedule-runner';
import {
  InvalidPartyCountError,
  runBoundedSchedules,
  UnsupportedScenarioError,
} from './schedule-runner';

// ---------------------------------------------------------------------------
// The planted invariant violation comes first: a runner that cannot find a
// bug reachable under exactly one interleaving is worthless, so this proves
// it can before anything else in this file is trusted.
// ---------------------------------------------------------------------------

describe('runBoundedSchedules — planted invariant violation', () => {
  /**
   * A deliberately racy scenario: `writer` sets `state.value` to 42 the
   * moment it is released; `reader` captures `state.value` the moment IT is
   * released. The invariant under test — `reader` always observes 42 — only
   * holds when `writer` is released before `reader`. There is no product
   * code involved; the "bug" lives entirely in this scenario's own
   * unsynchronized read, which is exactly the shape of race the runner
   * exists to catch.
   */
  function createRacyScenario() {
    return async (schedule: Schedule): Promise<void> => {
      const state = { value: 0 };
      let observed = -1;

      const writer = (async () => {
        await schedule.barrier('writer').arrive();
        state.value = 42;
      })();
      const reader = (async () => {
        await schedule.barrier('reader').arrive();
        observed = state.value;
      })();

      await schedule.releaseInOrder();
      await Promise.all([writer, reader]);

      if (observed !== 42) {
        throw new Error(
          `invariant violated: reader observed ${observed}, expected 42 (order: ${schedule.order.join(',')})`,
        );
      }
    };
  }

  it('finds the schedule that violates the invariant', async () => {
    const report = await runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['writer', 'reader'],
      scenario: createRacyScenario(),
      maximumSchedules: 2,
      seed: 'planted-violation',
    });

    expect(report.failingSchedule).toBeDefined();
    expect(report.failingSchedule).toEqual(['reader', 'writer']);
    expect(report.seed).toBe('planted-violation');
  });

  it('reproduces the identical failing schedule on a re-run with the reported seed', async () => {
    const first = await runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['writer', 'reader'],
      scenario: createRacyScenario(),
      maximumSchedules: 2,
      seed: 'planted-violation',
    });

    const second = await runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['writer', 'reader'],
      scenario: createRacyScenario(),
      maximumSchedules: 2,
      seed: first.seed,
    });

    expect(second.failingSchedule).toEqual(first.failingSchedule);
  });
});

// ---------------------------------------------------------------------------
// Bound behavior
// ---------------------------------------------------------------------------

describe('runBoundedSchedules — bound behavior', () => {
  it('reports a pass with schedulesRun equal to the bound when every schedule exhausts without failing', async () => {
    const visited: (readonly string[])[] = [];
    const report = await runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['a', 'b', 'c'],
      scenario: async (schedule) => {
        visited.push(schedule.order);
      },
      maximumSchedules: 6, // exactly 3! — the full permutation space
      seed: 'exhaustive-pass',
    });

    expect(report.failingSchedule).toBeUndefined();
    expect(report.schedulesRun).toBe(6);
    expect(visited).toHaveLength(6);
    // every permutation of a/b/c was attempted, none repeated
    const unique = new Set(visited.map((order) => order.join(',')));
    expect(unique.size).toBe(6);
  });

  it('never runs more schedules than maximumSchedules even when more orderings exist', async () => {
    let calls = 0;
    const report = await runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['a', 'b', 'c'],
      scenario: async () => {
        calls++;
      },
      maximumSchedules: 2,
      seed: 'bounded-below-space',
    });

    expect(calls).toBe(2);
    expect(report.schedulesRun).toBe(2);
    expect(report.failingSchedule).toBeUndefined();
  });

  it('never retries a failing schedule: a scenario that fails every time still runs exactly once per attempted ordering', async () => {
    const attempts: (readonly string[])[] = [];
    const report = await runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['a', 'b'],
      scenario: async (schedule) => {
        attempts.push(schedule.order);
        throw new Error('always fails');
      },
      maximumSchedules: 2,
      seed: 'no-retry',
    });

    expect(attempts).toHaveLength(1);
    expect(report.schedulesRun).toBe(1);
    expect(report.failingSchedule).toEqual(attempts[0]);
  });

  it('throws InvalidPartyCountError for a party count outside two or three', async () => {
    const attempt = (parties: readonly string[]) =>
      runBoundedSchedules({
        barriers: createBarrierRegistry(),
        parties,
        scenario: async () => {},
        maximumSchedules: 1,
        seed: 'party-count',
      });

    expect(attempt(['only-one'])).rejects.toBeInstanceOf(InvalidPartyCountError);
    expect(attempt(['a', 'b', 'c', 'd'])).rejects.toBeInstanceOf(InvalidPartyCountError);
    expect(attempt([])).rejects.toBeInstanceOf(InvalidPartyCountError);
  });

  it('propagates UnsupportedScenarioError immediately instead of recording it as a failing schedule', async () => {
    let calls = 0;
    const attempt = runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['a', 'b'],
      scenario: async () => {
        calls++;
        throw new UnsupportedScenarioError('example', 'AB-999');
      },
      maximumSchedules: 2,
      seed: 'unsupported',
    });

    expect(attempt).rejects.toBeInstanceOf(UnsupportedScenarioError);
    // The runner stops at the first attempt rather than treating the
    // capability gap as "schedule 1 failed, try schedule 2".
    expect(calls).toBe(1);
  });

  it('deterministically orders schedules by seed: two different seeds visit permutations in different sequences', async () => {
    async function firstVisitedOrder(seed: string): Promise<readonly string[]> {
      const visited: (readonly string[])[] = [];
      await runBoundedSchedules({
        barriers: createBarrierRegistry(),
        parties: ['a', 'b', 'c'],
        scenario: async (schedule) => {
          visited.push(schedule.order);
        },
        maximumSchedules: 1,
        seed,
      });
      const [firstOrder] = visited;
      if (!firstOrder) throw new Error('expected one visited schedule');
      return firstOrder;
    }

    const firstSeedOrder = await firstVisitedOrder('seed-one');
    const secondSeedOrder = await firstVisitedOrder('seed-two');

    // Not asserting WHICH orders — only that the seed genuinely drives the
    // sequence, so two different seeds are not guaranteed (nor required) to
    // coincide.
    expect(firstSeedOrder).not.toEqual(secondSeedOrder);
  });
});

// ---------------------------------------------------------------------------
// AB-95's six named scenarios. Each gets a bounded-schedule test; a scenario
// whose product surface does not exist on this baseline asserts the typed
// `UnsupportedScenarioError` naming its owning issue instead of being
// skipped.
// ---------------------------------------------------------------------------

describe('runBoundedSchedules — AB-95 scenarios', () => {
  it('session admission is unsupported on this baseline (AB-42, natively blocked on WFT-84)', async () => {
    const attempt = runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['session-a', 'session-b'],
      scenario: async () => {
        throw new UnsupportedScenarioError(
          'session admission',
          'AB-42',
          'no `submitSessionInput` runtime function exists yet — durable/types.ts only carries the illustrative type sketch.',
        );
      },
      maximumSchedules: 2,
      seed: 'session-admission',
    });

    expect(attempt).rejects.toMatchObject({
      name: 'UnsupportedScenarioError',
      owningIssue: 'AB-42',
    });
  });

  it('review resolution is unsupported on this baseline (AB-46)', async () => {
    const attempt = runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['reviewer-a', 'reviewer-b'],
      scenario: async () => {
        throw new UnsupportedScenarioError(
          'review resolution',
          'AB-46',
          'no `ReviewStatus`/review-decision surface exists in operative or bureau yet.',
        );
      },
      maximumSchedules: 2,
      seed: 'review-resolution',
    });

    expect(attempt).rejects.toMatchObject({
      name: 'UnsupportedScenarioError',
      owningIssue: 'AB-46',
    });
  });

  it('sibling completion: awaitChildrenClosed resolves after both children settle, regardless of release order', async () => {
    const scenario = async (schedule: Schedule): Promise<void> => {
      const registry = createChildRunRegistry();
      const ids = ['child-a', 'child-b'] as const;

      for (const id of ids) {
        registry.register({
          id,
          parentId: 'parent',
          agentName: 'agent',
          durable: false,
          abort: () => {},
        });
        registry.attachClosed(id, async () => {
          await schedule.barrier(id).arrive();
          return { status: 'completed' } as const;
        });
      }

      const awaited = registry.awaitChildrenClosed();
      await schedule.releaseInOrder();
      await awaited;

      const descriptors = registry.children();
      if (descriptors.length !== ids.length) {
        throw new Error(`expected ${ids.length} children registered, got ${descriptors.length}`);
      }
    };

    const report = await runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['child-a', 'child-b'],
      scenario,
      maximumSchedules: 2,
      seed: 'sibling-completion',
    });

    expect(report.failingSchedule).toBeUndefined();
    expect(report.schedulesRun).toBe(2);
  });

  it('parent abort: abortChild reaches only the targeted child, in either release order', async () => {
    const scenario = async (schedule: Schedule): Promise<void> => {
      const registry = createChildRunRegistry();
      let victimAborted = false;
      let bystanderAborted = false;

      registry.register({
        id: 'victim',
        parentId: 'parent',
        agentName: 'agent',
        durable: false,
        abort: () => {
          victimAborted = true;
        },
      });
      registry.register({
        id: 'bystander',
        parentId: 'parent',
        agentName: 'agent',
        durable: false,
        abort: () => {
          bystanderAborted = true;
        },
      });

      const victimTask = (async () => {
        await schedule.barrier('victim').arrive();
        registry.abortChild('victim', 'planted abort');
      })();
      const bystanderTask = (async () => {
        await schedule.barrier('bystander').arrive();
      })();

      await schedule.releaseInOrder();
      await Promise.all([victimTask, bystanderTask]);

      if (!victimAborted) throw new Error('victim was not aborted');
      if (bystanderAborted) throw new Error('bystander was aborted but should not have been');
    };

    const report = await runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['victim', 'bystander'],
      scenario,
      maximumSchedules: 2,
      seed: 'parent-abort',
    });

    expect(report.failingSchedule).toBeUndefined();
    expect(report.schedulesRun).toBe(2);
  });

  it('compaction commit: beforeCompaction and afterCompaction both observe the same conversation regardless of release order', async () => {
    const scenario = async (schedule: Schedule): Promise<void> => {
      const hooks = new HookRegistry<OperativeHookMap>();
      const conversation = new Conversation();
      const budget = createTokenBudget({ maxTokens: 1000 });

      let beforeSeen: unknown;
      let afterSeen: unknown;

      hooks.on('beforeCompaction', async (context) => {
        await schedule.barrier('before-compaction').arrive();
        beforeSeen = context.conversation;
      });
      hooks.on('afterCompaction', async (context) => {
        await schedule.barrier('after-compaction').arrive();
        afterSeen = context.conversation;
      });

      const beforeRun = hooks.run('beforeCompaction', { conversation, step: 1, budget });
      const afterRun = hooks.run('afterCompaction', {
        conversation,
        step: 1,
        messagesRemoved: 0,
        tokensFreed: 0,
      });

      await schedule.releaseInOrder();
      await Promise.all([beforeRun, afterRun]);

      if (beforeSeen !== conversation || afterSeen !== conversation) {
        throw new Error('compaction hooks did not observe the same conversation instance');
      }
    };

    const report = await runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['before-compaction', 'after-compaction'],
      scenario,
      maximumSchedules: 2,
      seed: 'compaction-commit',
    });

    expect(report.failingSchedule).toBeUndefined();
    expect(report.schedulesRun).toBe(2);
  });

  it('shutdown: closed() always settles with a defined acknowledgement regardless of drain/signal order', async () => {
    const scenario = async (schedule: Schedule): Promise<void> => {
      let drainComplete = false;
      let signalObserved = false;

      const result = (async () => {
        await schedule.barrier('signal').arrive();
        signalObserved = true;
        return 'terminal-result';
      })();

      const closed = createClosedAcknowledgement({
        result,
        disqualifiesFastPath: () => false,
        hasInFlightWork: () => !drainComplete,
        resolveOutcome: async () => ({ status: 'completed' }),
      });

      const drainTask = (async () => {
        await schedule.barrier('drain').arrive();
        drainComplete = true;
      })();

      const closePromise = closed();
      await schedule.releaseInOrder();
      await drainTask;
      const acknowledgement = await closePromise;

      if (!signalObserved) {
        throw new Error('shutdown scenario: the result promise never observed the signal');
      }
      if (acknowledgement.status !== 'completed' && acknowledgement.status !== 'not-required') {
        throw new Error(
          `shutdown scenario: unexpected acknowledgement status ${acknowledgement.status}`,
        );
      }
    };

    const report = await runBoundedSchedules({
      barriers: createBarrierRegistry(),
      parties: ['drain', 'signal'],
      scenario,
      maximumSchedules: 2,
      seed: 'shutdown',
    });

    expect(report.failingSchedule).toBeUndefined();
    expect(report.schedulesRun).toBe(2);
  });
});
