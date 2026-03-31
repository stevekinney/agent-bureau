import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { composeMutators } from '../../src/retry/compose-mutators';
import type { RetryMutator } from '../../src/retry/types';
import type { GenerateContext } from '../../src/types';

function makeContext(): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createTestToolbox([]),
  };
}

describe('composeMutators', () => {
  it('returns a mutator that runs all mutators in sequence', async () => {
    const log: string[] = [];

    const mutatorA: RetryMutator = async (context, _error, _attempt) => {
      log.push('A');
      const snapshot = context.conversation.getSnapshot();
      const conv = new Conversation({
        ...snapshot,
        metadata: { ...snapshot.metadata, a: true },
      });
      return { ...context, conversation: conv };
    };

    const mutatorB: RetryMutator = async (context, _error, _attempt) => {
      log.push('B');
      const snapshot = context.conversation.getSnapshot();
      const conv = new Conversation({
        ...snapshot,
        metadata: { ...snapshot.metadata, b: true },
      });
      return { ...context, conversation: conv };
    };

    const composed = composeMutators(mutatorA, mutatorB);
    const context = makeContext();
    const result = await composed(context, new Error('fail'), 1);

    expect(log).toEqual(['A', 'B']);
    expect(result).toBeDefined();
    expect(result!.conversation.getSnapshot().metadata['a']).toBe(true);
    expect(result!.conversation.getSnapshot().metadata['b']).toBe(true);
  });

  it('passes the modified context from one mutator to the next', async () => {
    let secondMutatorStep = -1;

    const mutatorA: RetryMutator = async (context) => {
      return { ...context, step: 42 };
    };

    const mutatorB: RetryMutator = async (context) => {
      secondMutatorStep = context.step;
      return context;
    };

    const composed = composeMutators(mutatorA, mutatorB);
    await composed(makeContext(), new Error('fail'), 1);

    expect(secondMutatorStep).toBe(42);
  });

  it('skips void returns and passes current context through', async () => {
    const log: string[] = [];

    const noopMutator: RetryMutator = async () => {
      log.push('noop');
      // Returns void
    };

    const realMutator: RetryMutator = async (context) => {
      log.push('real');
      return { ...context, step: 99 };
    };

    const composed = composeMutators(noopMutator, realMutator);
    const result = await composed(makeContext(), new Error('fail'), 1);

    expect(log).toEqual(['noop', 'real']);
    expect(result).toBeDefined();
    expect(result!.step).toBe(99);
  });

  it('returns void when all mutators return void', async () => {
    const noop1: RetryMutator = async () => {};
    const noop2: RetryMutator = async () => {};

    const composed = composeMutators(noop1, noop2);
    const result = await composed(makeContext(), new Error('fail'), 1);

    expect(result).toBeUndefined();
  });

  it('works with a single mutator', async () => {
    const mutator: RetryMutator = async (context) => {
      return { ...context, step: 7 };
    };

    const composed = composeMutators(mutator);
    const result = await composed(makeContext(), new Error('fail'), 1);

    expect(result).toBeDefined();
    expect(result!.step).toBe(7);
  });

  it('works with zero mutators', async () => {
    const composed = composeMutators();
    const result = await composed(makeContext(), new Error('fail'), 1);
    expect(result).toBeUndefined();
  });
});
