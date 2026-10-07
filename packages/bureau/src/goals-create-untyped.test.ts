/**
 * COR-851 — `goals.create` takes input from callers the type system does not
 * reach (a JSON body, a script), so every malformed field answers its typed
 * rejection and never throws, and nothing is written.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import {
  createCheckValidator,
  createDiagnostics,
  goalRequest,
  hangUntilAborted,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import type { Bureau } from './types';

const open: Bureau[] = [];

afterEach(async () => {
  for (const bureau of open.splice(0)) await bureau.dispose();
});

async function boot(): Promise<Bureau> {
  const bureau = await createBureau({
    agents: { worker: workerAgent(hangUntilAborted) },
    validators: [createCheckValidator()],
    storage: { type: 'memory' },
    durableExecution: true,
    onDiagnostic: createDiagnostics().onDiagnostic,
  });
  const typed = bureau as unknown as Bureau;
  open.push(typed);
  return typed;
}

const MALFORMED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['a null validator', { validator: null }],
  ['an omitted validator', { validator: undefined }],
  ['a string validator', { validator: 'check' }],
  ['a null identity', { identity: null }],
  ['an omitted identity', { identity: undefined }],
  ['a null bounds', { bounds: null }],
  ['an omitted bounds', { bounds: undefined }],
  ['a string bounds', { bounds: 'many' }],
  ['a null conversation policy', { conversationPolicy: null }],
  ['a string conversation policy', { conversationPolicy: 'continue' }],
  ['a null retry policy', { retryPolicy: null }],
  ['a string retry policy', { retryPolicy: 'always' }],
  ['a missing prompt', { prompt: undefined }],
  ['a numeric prompt', { prompt: 7 }],
  ['a numeric instructions', { instructions: 7 }],
  ['a null agent name', { agentName: null }],
  ['a numeric agent name', { agentName: 7 }],
  ['an object goal id', { goalRunId: {} }],
  ['a numeric goal id', { goalRunId: 7 }],
  ['an object principal', { principal: {} }],
  [
    'a fresh-from-artifact policy with a null artifact',
    { conversationPolicy: { kind: 'fresh-from-artifact', artifact: null }, instructions: 'go' },
  ],
  [
    'a fresh-from-artifact policy with no artifact',
    { conversationPolicy: { kind: 'fresh-from-artifact' }, instructions: 'go' },
  ],
  ['a fork policy with no baseline', { conversationPolicy: { kind: 'fork-from-baseline' } }],
  ['a validator with a numeric name', { validator: { name: 7, version: '1' } }],
];

describe('bureau.goals.create with input the types do not reach', () => {
  it.each(MALFORMED)(
    'answers a typed rejection for %s and writes nothing',
    async (_name, override) => {
      const bureau = await boot();
      const outcome = await bureau.goals.create(goalRequest(override));
      expect(outcome.outcome).toBe('rejected');
      expect(await bureau.goals.list()).toEqual([]);
    },
  );

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'goal'],
  ])('answers a typed rejection for a request that is %s', async (_name, request) => {
    const bureau = await boot();
    const outcome = await bureau.goals.create(request as never);
    expect(outcome.outcome).toBe('rejected');
  });
});
