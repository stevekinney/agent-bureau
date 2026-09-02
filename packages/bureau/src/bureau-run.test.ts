/**
 * `bureau.run(name, input, options?)` — AB-15/AB-22 typed catalog dispatch.
 *
 * Covers the AB-22 acceptance-criteria list this issue owns directly (as
 * opposed to AB-23's repository-native integration suite): unknown names,
 * lazy failure, JavaScript callers, direct execution, durable execution, and
 * synchronous-throw validation. Catalog ordering/querying and factory
 * initialization failure are covered by `agent-catalog.test.ts` and
 * `create-bureau.test.ts` respectively.
 */
import {
  AgentContractError,
  createAgent,
  createLazyAgent,
  type RunnableAgent,
} from '@lostgradient/operative';
import { createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BureauError, createBureau } from './create-bureau';

function mockGenerate(content = 'ok') {
  return async () => ({ content, toolCalls: [] });
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

describe('bureau.run', () => {
  it('throws BureauError NOT_FOUND for an unknown agent name (synchronous)', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    try {
      // `'missing'` is not a literal key of this bureau's `agents` — cast to
      // `never` to exercise the runtime guard for a name that arrived from
      // outside the static type (an HTTP path parameter, a webhook payload).
      expect(() => bureau.run('missing' as never, 'hi')).toThrow(BureauError);
      try {
        bureau.run('missing' as never, 'hi');
        throw new Error('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(BureauError);
        expect((error as BureauError).code).toBe('NOT_FOUND');
      }
    } finally {
      await bureau.dispose();
    }
  });

  it('throws BureauError BAD_REQUEST for input that is neither a string nor { conversation }', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    try {
      // @ts-expect-error — deliberately malformed input, exercising the runtime guard
      expect(() => bureau.run('echo', 42)).toThrow(BureauError);
      try {
        // @ts-expect-error — deliberately malformed input
        bureau.run('echo', null);
        throw new Error('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(BureauError);
        expect((error as BureauError).code).toBe('BAD_REQUEST');
      }
    } finally {
      await bureau.dispose();
    }
  });

  it('throws BureauError BAD_REQUEST when options.signal is not an AbortSignal', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    try {
      expect(() =>
        // @ts-expect-error — deliberately malformed options.signal
        bureau.run('echo', 'hi', { signal: 'nope' }),
      ).toThrow(BureauError);
    } finally {
      await bureau.dispose();
    }
  });

  it('throws BureauError BAD_REQUEST when options.withTraceContext is not a function', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    try {
      expect(() =>
        // @ts-expect-error — deliberately malformed options.withTraceContext
        bureau.run('echo', 'hi', { withTraceContext: 'nope' }),
      ).toThrow(BureauError);
    } finally {
      await bureau.dispose();
    }
  });

  it('throws BureauError CONFLICT once the bureau is disposed', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    await bureau.dispose();
    try {
      bureau.run('echo', 'hi');
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('CONFLICT');
    }
  });

  it('returns a non-thenable AgentRun synchronously (direct execution, no durable engine)', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate('hello from echo') }) },
    });
    try {
      const run = bureau.run('echo', 'hi');
      // AgentRun is deliberately non-thenable — `await run` must not resolve
      // through a `.then` on the handle itself.
      expect(typeof (run as unknown as { then?: unknown }).then).toBe('undefined');
      const result = await run.result();
      expect(result.content).toBe('hello from echo');
    } finally {
      await bureau.dispose();
    }
  });

  it('carries the literal output schema through direct execution', async () => {
    const outputSchema = z.object({ greeting: z.string() });
    const bureau = await createBureau({
      agents: {
        structured: createAgent({
          generate: mockGenerate('{"greeting":"hi"}'),
          output: outputSchema,
        }),
      },
    });
    try {
      const run = bureau.run('structured', 'hi');
      const output = await run.output();
      expect(output.greeting).toBe('hi');
    } finally {
      await bureau.dispose();
    }
  });

  it('drives the run through the durable engine when one is composed, checkpointed and discoverable via listDurableRuns', async () => {
    // Title deliberately does NOT claim "survives a crash simulation" — this
    // test only proves the run went through the durable engine and is
    // checkpointed/discoverable mid-flight. It does NOT simulate a process
    // restart and reattach, because that currently does not work for a
    // catalog run: see the "Known gap, not yet closed" note on `runAgent`'s
    // doc comment in create-bureau.ts (no session record is written for a
    // catalog dispatch, so boot recovery's resolver has no owning session to
    // find and returns `{ status: 'unavailable' }`).
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate('durable hello') }) },
      // No bureau-level generate/provider needed — `run()` dispatches through
      // the catalog agent's own generate; only the durable engine + storage
      // matter here.
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const before = await bureau.listDurableRuns();
      const run = bureau.run('echo', 'hi');
      const result = await run.result();
      expect(result.content).toBe('durable hello');

      const after = await bureau.listDurableRuns();
      expect(after?.total ?? 0).toBeGreaterThan(before?.total ?? 0);
      // The workflow id bureau.run() minted is discoverable through the
      // engine's own durable-run listing — proof this went through the
      // durable engine, not the agent's in-memory loop.
      expect(after?.items.some((item) => item.id.startsWith('agent-run-'))).toBe(true);
    } finally {
      await bureau.dispose();
    }
  });

  it('forwards abort() to the dispatched durable ActiveRun (AB-22 review fix: the outer wrapper going terminal must not leave the already-started durable workflow running unobserved)', async () => {
    let releaseGenerate: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    const bureau = await createBureau({
      agents: {
        echo: createAgent({
          generate: async () => {
            await pending;
            return { content: 'too late', toolCalls: [] };
          },
        }),
      },
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const run = bureau.run('echo', 'hi');
      // Abort immediately — before the resolver-then-createActiveRun chain
      // inside `runAgent`'s durable branch has necessarily settled. Without
      // forwarding this to the dispatched ActiveRun directly, the durable
      // workflow would keep running (and eventually call the generate
      // function with real side effects) even though this handle already
      // reports itself terminal.
      run.abort('caller cancelled immediately');
      releaseGenerate?.();
      const result = await run.result();
      expect(result.finishReason).toBe('aborted');
    } finally {
      await bureau.dispose();
    }
  });

  it('disposes the dispatched durable ActiveRun through Symbol.dispose', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate('durable hello') }) },
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const run = bureau.run('echo', 'hi');
      await run.result();
      expect(() => {
        run[Symbol.dispose]();
      }).not.toThrow();
    } finally {
      await bureau.dispose();
    }
  });

  it('falls back to direct (in-memory) execution for a durable bureau when the agent does not support definition resolution', async () => {
    const nonResolvingAgent: RunnableAgent<never, false> = {
      name: 'plain',
      run: (input, context) =>
        createAgent({ generate: mockGenerate('plain hello') }).run(input, context),
    };
    const bureau = await createBureau({
      agents: { plain: nonResolvingAgent },
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const before = await bureau.listDurableRuns();
      const result = await bureau.run('plain', 'hi').result();
      expect(result.content).toBe('plain hello');
      const after = await bureau.listDurableRuns();
      // No new durable workflow was created — this agent's own in-memory
      // run() handled it directly, bypassing the durable engine entirely.
      expect(after?.total ?? 0).toBe(before?.total ?? 0);
    } finally {
      await bureau.dispose();
    }
  });

  it('settles a lazy-load failure through the returned handle instead of throwing synchronously', async () => {
    const failingLazyAgent = createLazyAgent(() => Promise.reject(new Error('load failed')));
    const bureau = await createBureau({ agents: { lazy: failingLazyAgent } });
    try {
      // The synchronous call itself must not throw — the failure settles
      // through result()/unwrap() instead (AC: "lazy-load ... failures
      // settle through the returned handle"). `result()` always resolves
      // (never rejects) per the documented contract; a failure surfaces as
      // a non-`stop-condition` finishReason with an `error`.
      const run = bureau.run('lazy', 'hi');
      const result = await run.result();
      expect(result.finishReason).not.toBe('stop-condition');
      expect(result.error).toBeInstanceOf(Error);
    } finally {
      await bureau.dispose();
    }
  });

  it('settles a lazy agent that resolves to something without run() as an AgentContractError, not a synchronous throw', async () => {
    const brokenLazyAgent = createLazyAgent(
      // @ts-expect-error — deliberately not a valid RunnableAgent, to exercise the runtime contract guard
      () => Promise.resolve({ name: 'broken' }),
    );
    const bureau = await createBureau({ agents: { broken: brokenLazyAgent } });
    try {
      const run = bureau.run('broken', 'hi');
      const result = await run.result();
      expect(result.finishReason).not.toBe('stop-condition');
      expect(result.error).toBeInstanceOf(AgentContractError);
    } finally {
      await bureau.dispose();
    }
  });

  it('dispatches by a runtime string name — a JavaScript caller with no static AgentDefinitions type', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate('js caller hello') }) },
    });
    try {
      const dynamicName: string = ['echo'][0] ?? '';
      // `run` is typed to accept only `AgentNames<D>`, but at the JavaScript
      // boundary (no static types) any string is accepted and dispatched
      // through the same runtime `agentCatalog.find` lookup `find` uses.
      const run = bureau.run(dynamicName as 'echo', 'hi');
      const result = await run.result();
      expect(result.content).toBe('js caller hello');
    } finally {
      await bureau.dispose();
    }
  });

  it('threads options.traceContext and options.withTraceContext through to the dispatched run, and accepts (but does not use) options.sessionId on the direct dispatch branch', async () => {
    // Renamed from a title that also claimed "threads options.sessionId" —
    // this test's non-durable bureau never actually verified any effect
    // from sessionId (AgentRunContext, AB-15's ratified shape, has no
    // sessionId field for a bare RunnableAgent.run() to observe on this
    // branch at all). It is accepted without error here, which is the one
    // thing this non-durable case actually demonstrates. `runAgent`'s
    // durable branch DOES pass it to createActiveRun as the session-
    // correlation key (`sessionId: runOptions?.sessionId ?? runId` in
    // create-bureau.ts) — a source-level fact, not asserted by any test:
    // weft's WorkflowSummary (what listDurableRuns() returns) carries no
    // sessionId field to check it against, so verifying this would need a
    // lower-level engine handle this suite does not otherwise reach for.
    let sawTraceContext: unknown;
    const withTraceContext = async <T>(
      parentContext: unknown,
      fn: () => Promise<T>,
    ): Promise<T> => {
      sawTraceContext = parentContext;
      return fn();
    };
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate('traced') }) },
    });
    try {
      const run = bureau.run('echo', 'hi', {
        sessionId: 'session-1',
        traceContext: { requestId: 'abc' },
        withTraceContext,
      });
      const result = await run.result();
      expect(result.content).toBe('traced');
      expect(sawTraceContext).toEqual({ requestId: 'abc' });
    } finally {
      await bureau.dispose();
    }
  });

  it('accepts an empty agents catalog for a bureau that only uses createRun', async () => {
    const bureau = await createBureau({ agents: {}, toolbox: createEmptyToolbox() });
    try {
      expect(bureau.agents.names()).toEqual([]);
      expect(bureau.agents.has('anything')).toBe(false);
    } finally {
      await bureau.dispose();
    }
  });
});
