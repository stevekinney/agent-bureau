/**
 * COR-1419 — Bureau keeps a run's frame forwarder and event feed attached through `run.error`,
 * because Operative follows it with the `run.completed` that carries the finish reason. A durable
 * run whose engine loses a checkpoint compare-and-swap after `run.error` is abandoned to the
 * engine that won: `driveDurableRun` resolves its result quietly and dispatches no terminal event.
 * Nothing then detaches the run's listeners but the settled result, so that is where they must go.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  BudgetThresholdEvent,
  type GenerateFunction,
  type RunFrame,
} from '@lostgradient/operative';
import { resolveStorage } from '@lostgradient/weft';
import { createToolbox, type Tool } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';

import { createBureau } from './create-bureau';

const ORIGIN = '2026-10-04T00:00:00.000Z';

type WeftStorage = Awaited<ReturnType<typeof resolveStorage>>;

/** The slice of a Weft storage the injected loss touches, which not every storage backend has. */
interface ConditionalCommitStorage {
  get(key: string): Promise<Uint8Array | null | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  conditionalBatch(
    conditions: unknown,
    operations: readonly { type: string; key: string }[],
  ): Promise<unknown>;
}

/**
 * Makes the first checkpoint commit made after `hasFailed()` lose its compare-and-swap, as it does
 * when a second engine over the same store advances the run's checkpoint first: the stored
 * checkpoint changes under the commit, which is what separates a lost race from a failed write.
 */
function loseFirstCheckpointCommitAfter(
  storage: WeftStorage,
  hasFailed: () => boolean,
): { storage: WeftStorage; lost: Promise<void> } {
  let markLost: () => void = () => {};
  const lost = new Promise<void>((resolve) => {
    markLost = resolve;
  });
  let armed = true;
  const losing = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'conditionalBatch') {
        const backend = target as unknown as ConditionalCommitStorage;
        return async (
          conditions: unknown,
          operations: readonly { type: string; key: string }[],
        ) => {
          const checkpoint = operations.find(
            (operation) => operation.type === 'put' && /^wf:.+:ckpt$/.test(operation.key),
          );
          if (armed && checkpoint !== undefined && hasFailed()) {
            armed = false;
            const stored = await backend.get(checkpoint.key);
            await backend.put(checkpoint.key, new Uint8Array([...(stored ?? []), 0]));
            markLost();
          }
          return backend.conditionalBatch(conditions, operations);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { storage: losing, lost };
}

/** Lets every settled promise and its continuations run; nothing here waits on a clock. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('a durable run that fails and then loses its checkpoint compare-and-swap', () => {
  it('stops forwarding run frames once its result settles without a terminal event', async () => {
    // The run's emitter is not exposed, so capture it from the forwarder's own registration.
    const runEmitters = new Set<EventTarget>();
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    const addListener = spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(
      function (this: EventTarget, ...parameters: Parameters<EventTarget['addEventListener']>) {
        if (parameters[0] === 'budget.threshold') runEmitters.add(this);
        return originalAddEventListener.apply(this, parameters);
      },
    );

    // Weft reports a lost compare-and-swap to operators as a process warning. It is part of the
    // scenario, so capture it rather than let it reach stderr, and check it was raised.
    const warnings: Error[] = [];
    const emitWarning = spyOn(process, 'emitWarning').mockImplementation((warning) => {
      if (warning instanceof Error) warnings.push(warning);
    });

    let generateRejected = false;
    const generate: GenerateFunction = async () => {
      generateRejected = true;
      throw new Error('provider unavailable');
    };
    const base = await resolveStorage({ type: 'memory' });
    const race = loseFirstCheckpointCommitAfter(base, () => generateRejected);
    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createToolbox<readonly Tool[]>([]),
      runtime: createManualRuntimeServices({ origin: ORIGIN }),
      storage: race.storage,
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
    });
    try {
      const frames: RunFrame[] = [];
      bureau.subscribeLiveFrames((frame) => {
        if (frame.type === 'run-envelope') frames.push(frame.frame);
      });
      const run = await bureau.createRun({ message: 'Go.' });
      await race.lost;
      await settle();
      addListener.mockRestore();

      // The scenario this test exists for: the run reported an error and no terminal event.
      const kinds: string[] = [];
      for await (const envelope of bureau.runEventFeeds.get(run.id)!.feed.replay()) {
        kinds.push(envelope.kind);
      }
      expect(kinds).toContain('run.error');
      expect(kinds).not.toContain('run.completed');
      expect(frames.some((frame) => frame.type === 'run-finished')).toBe(false);
      expect(runEmitters.size).toBe(1);
      expect(warnings.map((warning) => warning.name)).toEqual([
        'WeftWorkflowCheckpointConflictWarning',
      ]);

      // A listener left attached would still turn an event on the settled run into a frame.
      const [emitter] = [...runEmitters];
      emitter!.dispatchEvent(
        new BudgetThresholdEvent({ threshold: 0.8, currentCost: 4, budget: 5, model: 'model' }),
      );
      expect(
        frames.filter(
          (frame) => frame.type === 'notification' && frame.code === 'budget.threshold',
        ),
      ).toEqual([]);
    } finally {
      addListener.mockRestore();
      emitWarning.mockRestore();
      await bureau.dispose();
    }
  });
});
