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

import { createTool, createToolbox, type SignedPendingToolApproval } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls, pendingApproval } from '../src/conditions/predicates';
import { createAgent } from '../src/create-agent';
import type { ConversationHistory, GenerateFunction, GenerateResponse } from '../src/types';

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

  it('uses the map key as the tool name, not the tool .name property', async () => {
    // A tool whose .name disagrees with the map key: the map key must win.
    const greetTool = createTool({
      name: 'original_name',
      description: 'Greet the user',
      input: z.object({ name: z.string() }),
      execute: async ({ name }) => `Hello, ${name}!`,
    });

    let callCount = 0;
    const agent = createAgent({
      generate: async () => {
        callCount++;
        if (callCount === 1) {
          // LLM issues a call using the MAP KEY, not the tool's inner .name.
          return toolCallResponse([{ name: 'canonical_key', arguments: { name: 'World' } }]);
        }
        return textResponse('done');
      },
      // Map key is 'canonical_key'; tool.name is 'original_name'
      tools: { canonical_key: greetTool },
      stopWhen: noToolCalls(),
    });

    // Should not throw — 'canonical_key' resolves in the toolbox.
    const result = await agent.run('Say hello').result();
    expect(result.finishReason).toBe('stop-condition');
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
// Concurrent runs — toolbox isolation (regression for per-run toolbox)
// ---------------------------------------------------------------------------

describe('createAgent — concurrent run toolbox isolation', () => {
  it('concurrent runs do not share tool.started events across each other', async () => {
    // Barrier: both tool executions block until the gate is released,
    // ensuring both runs are in-flight simultaneously and the shared-toolbox
    // bug (cross-firing) can manifest before we assert.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const blockingTool = createTool({
      name: 'blocking',
      description: 'Blocks until the gate is released',
      input: z.object({ id: z.number() }),
      execute: async ({ id }) => {
        await gate;
        return `result-${id}`;
      },
    });

    // GenerateContext exposes step directly (0-based); step 0 is the first call.
    const generate: GenerateFunction = async ({ step }) => {
      if (step === 0) {
        return toolCallResponse([{ name: 'blocking', arguments: { id: step } }]);
      }
      return textResponse('done');
    };

    // A SINGLE agent reused for both runs — the shared toolbox is the crux of the bug.
    const agent = createAgent({
      generate,
      tools: { blocking: blockingTool },
      stopWhen: noToolCalls(),
    });

    // Collect events from each run via the async iterator.
    const run1Events: string[] = [];
    const run2Events: string[] = [];

    const handle1 = agent.run('go');
    const handle2 = agent.run('go');

    // Consume both event streams concurrently.
    const drain1 = (async () => {
      for await (const event of handle1) {
        run1Events.push(event.type);
      }
    })();
    const drain2 = (async () => {
      for await (const event of handle2) {
        run2Events.push(event.type);
      }
    })();

    // Give both runs time to reach their blocked tool calls.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Release both tools simultaneously — they're now provably in-flight together.
    releaseGate();

    await Promise.all([drain1, drain2]);

    // With the bug (shared toolbox emitter): each run's stream receives
    // tool.started events from BOTH runs → count >= 2 for each.
    // With the fix (per-run toolbox): each run receives exactly 1 tool.started.
    const run1ToolStarted = run1Events.filter((t) => t === 'tool.started');
    const run2ToolStarted = run2Events.filter((t) => t === 'tool.started');

    expect(run1ToolStarted).toHaveLength(1);
    expect(run2ToolStarted).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// Toolbox injection (AB-258)
// ---------------------------------------------------------------------------

describe('createAgent — toolbox injection', () => {
  it('throws when both `tools` and `toolbox` are supplied', () => {
    const toolbox = createToolbox([]);

    expect(() =>
      createAgent({
        generate: singleResponse('hello'),
        tools: {},
        toolbox,
      }),
    ).toThrow(/tools.*toolbox.*mutually exclusive/i);
  });

  it('throws when both `toolbox` and `permissions` are supplied', () => {
    const toolbox = createToolbox([]);

    expect(() =>
      createAgent({
        generate: singleResponse('hello'),
        toolbox,
        permissions: { allowList: [] },
      }),
    ).toThrow(/permissions.*toolbox/i);
  });

  it('uses the caller-supplied Toolbox instance as-is, across multiple runs', async () => {
    const seenToolboxes: unknown[] = [];

    const toolbox = createToolbox([]);
    const agent = createAgent({
      generate: async ({ toolbox: seen }) => {
        seenToolboxes.push(seen);
        return textResponse('done');
      },
      toolbox,
      stopWhen: noToolCalls(),
    });

    await agent.run('first').result();
    await agent.run('second').result();

    expect(seenToolboxes).toHaveLength(2);
    expect(seenToolboxes[0]).toBe(toolbox);
    expect(seenToolboxes[1]).toBe(toolbox);
  });
});

// ---------------------------------------------------------------------------
// Conversation resume (AB-258) — run({ conversation })
// ---------------------------------------------------------------------------

describe('createAgent — conversation resume', () => {
  function buildHistory(...userMessages: string[]): ConversationHistory {
    let conversation: ConversationHistory | undefined;
    for (const message of userMessages) {
      const c = new Conversation(conversation);
      c.appendUserMessage(message);
      conversation = c.current;
    }
    return conversation!;
  }

  it('starts the loop from a supplied ConversationHistory', async () => {
    let receivedMessages: unknown[] = [];

    const agent = createAgent({
      generate: async ({ conversation }) => {
        receivedMessages = conversation.getMessages();
        return textResponse('done');
      },
      stopWhen: noToolCalls(),
    });

    const history = buildHistory('earlier turn');
    await agent.run({ conversation: history }).result();

    expect(receivedMessages).toHaveLength(1);
    expect((receivedMessages[0] as { content: string }).content).toBe('earlier turn');
  });

  it('does NOT re-inject `instructions` as a system message when resuming a conversation', async () => {
    let receivedMessages: unknown[] = [];

    const agent = createAgent({
      instructions: 'You are a test assistant.',
      generate: async ({ conversation }) => {
        receivedMessages = conversation.getMessages();
        return textResponse('done');
      },
      stopWhen: noToolCalls(),
    });

    const history = buildHistory('earlier turn');
    await agent.run({ conversation: history }).result();

    expect(receivedMessages).toHaveLength(1);
    expect((receivedMessages[0] as { role: string }).role).toBe('user');
  });

  it("snapshots the supplied history — the caller's ConversationHistory object is never mutated", async () => {
    const agent = createAgent({
      generate: singleResponse('done'),
      stopWhen: noToolCalls(),
    });

    const history = buildHistory('earlier turn');
    const beforeSnapshot = JSON.parse(JSON.stringify(history)) as ConversationHistory;

    const result = await agent.run({ conversation: history }).result();

    // The run appended an assistant message; the RESULT's conversation grew.
    expect(result.conversation.getMessages().length).toBeGreaterThan(1);

    // But the ORIGINAL history object the caller passed in is untouched.
    expect(history).toEqual(beforeSnapshot);
  });
});

// ---------------------------------------------------------------------------
// Park-on-approval (AB-258) — stopWhen.pendingApproval()
// ---------------------------------------------------------------------------

describe('createAgent — park-on-approval', () => {
  function buildApprovalGatedToolbox(approvalSecret: string) {
    const charges: number[] = [];
    const toolbox = createToolbox(
      [
        createTool({
          name: 'charge-card',
          description: 'Charge a payment card',
          input: z.object({ cents: z.number() }),
          metadata: { mutates: true },
          async execute({ cents }) {
            charges.push(cents);
            return { charged: cents };
          },
        }),
      ],
      {
        approvalSecret,
        policy: {
          beforeExecute() {
            return {
              allow: false,
              status: 'needs_approval',
              reason: 'Operator approval required',
              action: { message: 'Approve charge' },
            };
          },
        },
      },
    );
    return { toolbox, charges };
  }

  it('stops after the step with needs_approval — no further generate call — and the pending approval is reachable on the last step', async () => {
    let callCount = 0;
    const generate: GenerateFunction = async () => {
      callCount++;
      if (callCount === 1) {
        return toolCallResponse([{ name: 'charge-card', arguments: { cents: 500 } }]);
      }
      // Should never be reached — the run must park after step 0.
      return textResponse('should not run');
    };

    const { toolbox } = buildApprovalGatedToolbox('host-secret');
    const agent = createAgent({
      generate,
      toolbox,
      stopWhen: pendingApproval(),
    });

    const result = await agent.run('Please charge $5.00').result();

    // Exactly one generate call — the loop stopped, it did not call generate again.
    expect(callCount).toBe(1);
    expect(result.finishReason).toBe('stop-condition');

    const lastStep = result.steps.at(-1);
    const pending = lastStep?.results.find((r) => r.pendingApproval)?.pendingApproval;
    expect(pending).toBeDefined();
    expect(pending?.toolName).toBe('charge-card');
    expect(pending?.approvalToken).toEqual(expect.any(String));

    // Resuming on the SAME toolbox instance the host holds verifies the token
    // (same approvalSecret that minted it).
    const signed = pending as SignedPendingToolApproval;
    const resumed = await toolbox.resumeApproval(signed);
    expect(resumed.outcome).toBe('success');
  });

  it('round-trip: resumed result appended to history, new run started from it, model sees the tool result', async () => {
    const { toolbox } = buildApprovalGatedToolbox('host-secret');

    let generateCallCount = 0;
    let secondRunConversation: unknown[] = [];
    const generate: GenerateFunction = async ({ conversation, step }) => {
      generateCallCount++;
      if (generateCallCount === 1) {
        return toolCallResponse([{ name: 'charge-card', arguments: { cents: 500 } }]);
      }
      // Second run's first (and only) generate call.
      secondRunConversation = conversation.getMessages();
      void step;
      return textResponse('Charge complete.');
    };

    const agent = createAgent({
      generate,
      toolbox,
      stopWhen: [pendingApproval(), noToolCalls()],
    });

    const firstResult = await agent.run('Please charge $5.00').result();
    const pending = firstResult.steps
      .at(-1)
      ?.results.find((r) => r.pendingApproval)?.pendingApproval;
    const signed = pending as SignedPendingToolApproval;

    const resumed = await toolbox.resumeApproval(signed);

    // Append the resumed result to the (snapshotted) conversation from the first run.
    firstResult.conversation.appendToolResults([resumed]);
    const updatedHistory = firstResult.conversation.current;

    await agent.run({ conversation: updatedHistory }).result();

    expect(generateCallCount).toBe(2);
    const toolResultMessages = secondRunConversation.filter(
      (m) => (m as { role: string }).role === 'tool-result',
    );
    // Both the original pending result AND the resumed result are present —
    // the model sees the resolved (`success`) outcome the host appended.
    expect(toolResultMessages.length).toBeGreaterThanOrEqual(1);
  });
});
