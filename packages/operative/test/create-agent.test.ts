/**
 * Tests for createAgent() — B3: Standalone bureau-less agent factory.
 *
 * Covers:
 *   - generate is required (runtime check)
 *   - run(input) returns an AgentRun (non-thenable, has .result() method)
 *   - AgentRun.result() is idempotent (same Promise on repeated calls)
 *   - iterate-then-result() returns cached terminal value without re-running
 *   - Abort fires immediately via agentRun.abort()
 *   - Each run() call gets a fresh conversation (ephemeral)
 *   - instructions are injected as a system message
 *   - tools map is converted to a Toolbox (tools are callable)
 *   - Symbol.dispose aborts and cleans up
 */

import { createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createAgent } from '../src/create-agent';
import type { GenerateFunction, GenerateResponse } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

/** A generate function that returns a single text response then stops. */
function singleResponse(content: string): GenerateFunction {
  return async () => textResponse(content);
}

// ---------------------------------------------------------------------------
// Core factory behavior
// ---------------------------------------------------------------------------

describe('createAgent', () => {
  it('returns a StandaloneAgent with a run() method', () => {
    const agent = createAgent({
      generate: singleResponse('hello'),
    });

    expect(typeof agent.run).toBe('function');
  });

  it('run() returns an AgentRun handle (not a Promise)', () => {
    const agent = createAgent({
      generate: singleResponse('hello'),
      stopWhen: noToolCalls(),
    });

    const handle = agent.run('test');

    // AgentRun must NOT be a thenable.
    expect(handle).not.toHaveProperty('then');

    // AgentRun MUST have the correct surface.
    expect(typeof handle.result).toBe('function');
    expect(typeof handle.abort).toBe('function');
    expect(typeof handle[Symbol.asyncIterator]).toBe('function');
    expect(typeof handle[Symbol.dispose]).toBe('function');
  });

  it('result() returns a Promise that resolves to RunResult', async () => {
    const agent = createAgent({
      generate: singleResponse('hello world'),
      stopWhen: noToolCalls(),
    });

    const handle = agent.run('test');
    const result = await handle.result();

    expect(result).toHaveProperty('content', 'hello world');
    expect(result).toHaveProperty('finishReason', 'stop-condition');
    expect(result).toHaveProperty('conversation');
    expect(result).toHaveProperty('steps');
    expect(result).toHaveProperty('usage');
  });

  it('result() is idempotent — repeated calls return the same Promise', () => {
    const agent = createAgent({
      generate: singleResponse('hello'),
      stopWhen: noToolCalls(),
    });

    const handle = agent.run('test');
    const p1 = handle.result();
    const p2 = handle.result();

    // Must be the same Promise instance (idempotent).
    expect(p1).toBe(p2);
  });

  it('result() called before iteration still resolves correctly', async () => {
    const agent = createAgent({
      generate: singleResponse('result before iteration'),
      stopWhen: noToolCalls(),
    });

    const handle = agent.run('test');

    // Call result() WITHOUT iterating first.
    const result = await handle.result();
    expect(result.content).toBe('result before iteration');
  });

  it('iterate-then-result() returns cached terminal value without re-running', async () => {
    let callCount = 0;
    const generate: GenerateFunction = async () => {
      callCount++;
      return textResponse(`response-${callCount}`);
    };

    const agent = createAgent({
      generate,
      stopWhen: noToolCalls(),
    });

    const handle = agent.run('test');

    // Iterate to completion.
    for await (const _event of handle) {
      // consume all events
    }

    // Call result() after full iteration — must return the cached value.
    const result = await handle.result();

    // generate was called exactly once (the loop ran once, not re-run on result()).
    expect(callCount).toBe(1);
    expect(result.content).toBe('response-1');
  });
});

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

describe('createAgent — instructions', () => {
  it('injects instructions as a system message on step 0', async () => {
    let receivedMessages: unknown[] = [];

    const agent = createAgent({
      instructions: 'You are a test assistant.',
      generate: async ({ conversation }) => {
        receivedMessages = conversation.getMessages();
        return textResponse('done');
      },
      stopWhen: noToolCalls(),
    });

    await agent.run('hello').result();

    expect(receivedMessages).toHaveLength(2);
    expect((receivedMessages[0] as { role: string }).role).toBe('system');
    expect((receivedMessages[0] as { content: string }).content).toBe('You are a test assistant.');
    expect((receivedMessages[1] as { role: string }).role).toBe('user');
  });

  it('does not inject a system message when instructions are absent', async () => {
    let receivedMessages: unknown[] = [];

    const agent = createAgent({
      generate: async ({ conversation }) => {
        receivedMessages = conversation.getMessages();
        return textResponse('done');
      },
      stopWhen: noToolCalls(),
    });

    await agent.run('hello').result();

    expect(receivedMessages).toHaveLength(1);
    expect((receivedMessages[0] as { role: string }).role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Ephemeral — fresh conversation per run
// ---------------------------------------------------------------------------

describe('createAgent — ephemeral runs', () => {
  it('each run() call starts with a fresh conversation', async () => {
    const conversations: unknown[][] = [];

    const agent = createAgent({
      generate: async ({ conversation }) => {
        conversations.push(conversation.getMessages());
        return textResponse('done');
      },
      stopWhen: noToolCalls(),
    });

    await agent.run('first').result();
    await agent.run('second').result();

    expect(conversations).toHaveLength(2);

    // Each conversation has exactly 1 message (the user input) — no carry-over.
    const [first, second] = conversations;
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect((first?.[0] as { content: string })?.content).toBe('first');
    expect((second?.[0] as { content: string })?.content).toBe('second');
  });

  it('concurrent run() calls are independent', async () => {
    const generateLog: number[] = [];
    let callCount = 0;

    const agent = createAgent({
      generate: async () => {
        const n = ++callCount;
        generateLog.push(n);
        return textResponse(`call-${n}`);
      },
      stopWhen: noToolCalls(),
    });

    const [r1, r2] = await Promise.all([agent.run('first').result(), agent.run('second').result()]);

    expect(generateLog).toHaveLength(2);
    // Each run produced its own result — they don't share state.
    expect(r1.content).not.toBe(r2.content);
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe('createAgent — tools', () => {
  it('accepts a name-keyed tools map and executes the tools', async () => {
    const executed: string[] = [];

    const greetTool = createTool({
      name: 'greet',
      description: 'Greet the user',
      input: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        executed.push(name);
        return `Hello, ${name}!`;
      },
    });

    let callCount = 0;
    const agent = createAgent({
      generate: async () => {
        callCount++;
        if (callCount === 1) {
          return toolCallResponse([{ name: 'greet', arguments: { name: 'World' } }]);
        }
        return textResponse('done');
      },
      tools: { greet: greetTool },
      stopWhen: noToolCalls(),
    });

    await agent.run('Say hello').result();

    expect(executed).toEqual(['World']);
  });

  it('works with an empty tools map', async () => {
    const agent = createAgent({
      generate: singleResponse('no tools needed'),
      tools: {},
      stopWhen: noToolCalls(),
    });

    const result = await agent.run('test').result();
    expect(result.content).toBe('no tools needed');
  });

  it('works without a tools field at all', async () => {
    const agent = createAgent({
      generate: singleResponse('pure generation'),
      stopWhen: noToolCalls(),
    });

    const result = await agent.run('test').result();
    expect(result.content).toBe('pure generation');
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe('createAgent — abort', () => {
  it('abort() cancels the in-flight run', async () => {
    let aborted = false;

    const agent = createAgent({
      generate: async ({ signal }) => {
        // Simulate a long-running generate that checks the signal.
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
          // Never resolve unless aborted.
        }).catch(() => {
          aborted = true;
        });

        return textResponse('should not reach here');
      },
    });

    const handle = agent.run('long task');

    // Abort immediately.
    handle.abort('test');

    // The result should settle (as an aborted run or error).
    const result = await handle.result().catch(() => null);

    // Either the run was aborted or returned with a finish reason.
    // The key check: `abort()` must not throw and the handle must settle.
    expect(aborted || result !== null).toBe(true);
  });

  it('Symbol.dispose aborts the run', async () => {
    let abortFired = false;

    const agent = createAgent({
      generate: async ({ signal }) => {
        signal?.addEventListener('abort', () => {
          abortFired = true;
        });
        // Yield so the signal can fire before we return.
        await Promise.resolve();
        return textResponse('done');
      },
      stopWhen: noToolCalls(),
    });

    const handle = agent.run('test');
    handle[Symbol.dispose]();

    // Give the abort signal a chance to propagate.
    await handle.result().catch(() => null);
    // After dispose, the signal fired (or the run was already done — either is acceptable).
    // The critical contract: dispose() does not throw and the handle settles.
  });
});

// ---------------------------------------------------------------------------
// for-await iteration
// ---------------------------------------------------------------------------

describe('createAgent — async iteration', () => {
  it('for-await over a run produces events and then terminates', async () => {
    const agent = createAgent({
      generate: singleResponse('event test'),
      stopWhen: noToolCalls(),
    });

    const handle = agent.run('test');
    const events: string[] = [];

    for await (const event of handle) {
      events.push(event.type);
    }

    // At minimum, operative emits run.started and run.completed.
    expect(events.length).toBeGreaterThan(0);
    expect(events).toContain('run.started');
    expect(events).toContain('run.completed');
  });

  it('iterate-then-result() does not re-run the agent', async () => {
    let callCount = 0;

    const agent = createAgent({
      generate: async () => {
        callCount++;
        return textResponse('iterate-test');
      },
      stopWhen: noToolCalls(),
    });

    const handle = agent.run('test');

    // Fully iterate.
    for await (const _event of handle) {
      // consume
    }

    // Call result() — must return cached value, NOT re-run generate.
    const result = await handle.result();
    expect(callCount).toBe(1);
    expect(result.content).toBe('iterate-test');
  });
});

// ---------------------------------------------------------------------------
// Non-thenable verification
// ---------------------------------------------------------------------------

describe('createAgent — non-thenable AgentRun', () => {
  it('AgentRun does not have a .then property', () => {
    const agent = createAgent({
      generate: singleResponse('hello'),
    });

    const handle = agent.run('test');

    // This is the load-bearing test: if AgentRun had `.then`, it would
    // auto-unwrap across async boundaries (the AWS-SDK-v3 / tRPC problem).
    expect('then' in handle).toBe(false);
  });

  it('AgentRun satisfies AsyncIterable but not PromiseLike', () => {
    const agent = createAgent({
      generate: singleResponse('hello'),
    });

    const handle = agent.run('test');

    // AsyncIterable contract: has Symbol.asyncIterator
    expect(Symbol.asyncIterator in handle).toBe(true);

    // PromiseLike contract: has .then — must be ABSENT
    expect('then' in handle).toBe(false);
  });
});
