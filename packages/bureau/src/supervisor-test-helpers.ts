import type { AgentInput, AgentRun, RunResult } from '@lostgradient/operative';
import { Conversation } from 'conversationalist';

export function makeRunResult(
  content: string,
  finishReason: RunResult['finishReason'] = 'stop-condition',
): RunResult {
  return {
    content,
    steps: [],
    conversation: new Conversation(),
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason,
  };
}

export function makeFailedRunResult(
  finishReason: RunResult['finishReason'],
  error?: Error,
): RunResult {
  return { ...makeRunResult('', finishReason), error };
}

/** Deliberately violate the result contract as an untyped JavaScript agent can. */
export function makeMalformedRunResult(): RunResult {
  const result = makeRunResult('');
  for (const key of Object.keys(result)) Reflect.deleteProperty(result, key);
  return result;
}

export function requireError(value: unknown): Error {
  if (!(value instanceof Error)) throw new Error('Expected an Error result');
  return value;
}

function unexpectedRunMethod(): never {
  throw new Error('Supervisor called a run capability outside this fixture contract');
}

/** Synchronous run fixture; unexercised capabilities fail if unexpectedly called. */
export function makeAgent(
  name: string,
  respond: (input: string) => Promise<RunResult> = (input) =>
    Promise.resolve(makeRunResult(`${name}: ${input}`)),
) {
  const receivedInputs: string[] = [];
  return {
    fixture: {
      name,
      hasOutput: false,
      run: (rawInput: AgentInput): AgentRun => {
        if (typeof rawInput !== 'string') throw new Error('Fixture expects a string input');
        receivedInputs.push(rawInput);
        return {
          result: () => respond(rawInput),
          unwrap: () => Promise.reject(new Error('not used by these tests')),
          abort: () => {},
          children: unexpectedRunMethod,
          abortChild: unexpectedRunMethod,
          closed: unexpectedRunMethod,
          snapshot: unexpectedRunMethod,
          subscribeSnapshot: unexpectedRunMethod,
          [Symbol.dispose]: () => {},
          [Symbol.asyncIterator]: unexpectedRunMethod,
        };
      },
    },
    receivedInputs,
  };
}
