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
  type AgentRun,
  createAgent,
  createLazyAgent,
  createSubagentTool,
  type DefinitionResolvingAgent,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type RunnableAgent,
} from '@lostgradient/operative';
import { createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BureauError, createBureau } from './create-bureau';
import type { BureauRunOptions } from './types';

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

  it('exposes children() and abortChild() on the handle returned by a direct-dispatch (non-durable) run (AB-50, guarded against the createDeferredAgentRun rewrite regressing them)', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    try {
      const run = bureau.run('echo', 'hi');
      expect(typeof run.children).toBe('function');
      expect(typeof run.abortChild).toBe('function');
      expect(run.children()).toEqual([]);
      await run.result();
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

  it('throws BureauError BAD_REQUEST when options is an array (typeof [] === "object" does not make it a valid options bag)', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ generate: mockGenerate() }) },
    });
    try {
      expect(() =>
        // @ts-expect-error — deliberately an array, not a BureauRunOptions object
        bureau.run('echo', 'hi', []),
      ).toThrow(BureauError);
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

  it('reads the resolver capability before the direct-dispatch durability branch', async () => {
    let resolverReads = 0;
    const base = createAgent({ generate: mockGenerate() });
    const agent: RunnableAgent & DefinitionResolvingAgent = {
      name: base.name,
      hasOutput: base.hasOutput,
      run: base.run,
      get [OPERATIVE_RESOLVE_RUN_OPTIONS]() {
        resolverReads += 1;
        return undefined;
      },
    };
    const bureau = await createBureau({ agents: { echo: agent } });
    try {
      const run = bureau.run('echo', 'hi');
      expect(resolverReads).toBe(1);
      await run.result();
    } finally {
      await bureau.dispose();
    }
  });

  it('settles a direct-dispatch agent whose run() throws synchronously through the returned handle, not as a synchronous throw from bureau.run() itself', async () => {
    // AB-22's synchronous-throw allowlist is unknown name / disposed /
    // malformed input-options only — a hand-written catalog RunnableAgent
    // is a valid entry, and its run() throwing during per-run setup must
    // not escape bureau.run() as a bare exception (review round 2, Codex).
    const throwingAgent: RunnableAgent<unknown, boolean> = {
      name: 'throws',
      hasOutput: false,
      run: () => {
        throw new Error('setup exploded');
      },
    };
    const bureau = await createBureau({ agents: { throws: throwingAgent } });
    try {
      const run = bureau.run('throws', 'hi'); // must not throw here
      const result = await run.result();
      expect(result.finishReason).not.toBe('stop-condition');
      expect(result.error).toBeInstanceOf(Error);
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
    // checkpointed/discoverable mid-flight. A process-restart reattach test
    // (AB-240) lives in `create-bureau.test.ts` alongside the other
    // cross-process recovery tests — see "reattaches a catalog-dispatched
    // bureau.run() across a process restart, rebuilding deps from the
    // catalog agent's own OPERATIVE_RESOLVE_RUN_OPTIONS".
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
    const nonResolvingAgent: RunnableAgent = {
      name: 'plain',
      hasOutput: false,
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

  it('falls back to direct execution for a LAZY-wrapped agent whose resolved module does not support definition resolution (review round 2, Codex)', async () => {
    // `createLazyAgent` always exposes the definition-resolution symbol as a
    // proxy — `typeof resolver === 'function'` is true for every lazy
    // wrapper regardless of whether the module it eventually loads actually
    // supports it. Without the AgentContractError-triggered fallback, this
    // exact scenario (a durable bureau + a lazy-wrapped non-resolving
    // agent) would route into the durable branch and fail there, even
    // though the non-lazy version of the same agent (the test above)
    // correctly falls back to direct dispatch.
    const lazyNonResolvingAgent = createLazyAgent(() =>
      Promise.resolve<RunnableAgent>({
        name: 'plain',
        hasOutput: false,
        run: (input, context) =>
          createAgent({ generate: mockGenerate('lazy plain hello') }).run(input, context),
      }),
    );
    const bureau = await createBureau({
      agents: { plain: lazyNonResolvingAgent },
      storage: { type: 'memory' },
      durableExecution: true,
    });
    try {
      const before = await bureau.listDurableRuns();
      const result = await bureau.run('plain', 'hi').result();
      expect(result.content).toBe('lazy plain hello');
      const after = await bureau.listDurableRuns();
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

  describe('options.principal (AB-241)', () => {
    it('throws BureauError BAD_REQUEST when options.principal is not a string', async () => {
      const bureau = await createBureau({
        agents: { echo: createAgent({ generate: mockGenerate() }) },
      });
      try {
        expect(() =>
          // @ts-expect-error — deliberately malformed options.principal
          bureau.run('echo', 'hi', { principal: 42 }),
        ).toThrow(BureauError);
      } finally {
        await bureau.dispose();
      }
    });

    it('rejects a principal getter whose FIRST read is malformed, never giving it a second chance to look valid (AB-241 review finding)', async () => {
      const bureau = await createBureau({
        agents: { echo: createAgent({ generate: mockGenerate() }) },
      });
      try {
        let reads = 0;
        const options = {} as BureauRunOptions;
        Object.defineProperty(options, 'principal', {
          // First read (the only one a correct implementation performs) is
          // malformed; a second, independent read would return a valid
          // string. A caller reading `options.principal` twice — once to
          // validate, once to use — could see this getter validate the
          // FIRST read then use the second, silently accepting an option
          // this call is supposed to reject synchronously.
          get: () => (reads++ === 0 ? 42 : 'alice'),
        });
        expect(() => bureau.run('echo', 'hi', options)).toThrow(BureauError);
        expect(reads).toBe(1);
      } finally {
        await bureau.dispose();
      }
    });

    it('validates and attributes the SAME captured principal value even when options.principal is a getter whose result changes on a later read (AB-241 review finding)', async () => {
      const bureau = await createBureau({
        agents: { echo: createAgent({ generate: mockGenerate('durable hello') }) },
        storage: { type: 'memory' },
        durableExecution: true,
      });
      try {
        let reads = 0;
        const options = {} as BureauRunOptions;
        Object.defineProperty(options, 'principal', {
          // First read (the only one this call should perform) is a valid
          // string; a later, independent read would return a different,
          // malformed value. A caller re-reading `options.principal` after
          // validation — at `persistCatalogRunRecoveryRecord` or the
          // `createActiveRun` owner argument, both after an `await` — could
          // otherwise attribute this run to a DIFFERENT, unvalidated value
          // than the one that was checked.
          get: () => (reads++ === 0 ? 'alice' : 42),
        });
        const run = bureau.run('echo', 'hi', options);
        await run.result();
        expect(run.snapshot().owner).toBe('alice');
        expect(reads).toBe(1);
      } finally {
        await bureau.dispose();
      }
    });

    it('forwards options.principal to the agent as AgentRunContext.principal on the direct (non-durable) dispatch branch', async () => {
      let sawContextPrincipal: string | undefined;
      const capturingAgent: RunnableAgent = {
        name: 'capturing',
        hasOutput: false,
        run: (input, context) => {
          sawContextPrincipal = context?.principal;
          return createAgent({ generate: mockGenerate('captured') }).run(input, context);
        },
      };
      const bureau = await createBureau({ agents: { capturing: capturingAgent } });
      try {
        const run = bureau.run('capturing', 'hi', { principal: 'alice' });
        await run.result();
        expect(sawContextPrincipal).toBe('alice');
      } finally {
        await bureau.dispose();
      }
    });

    it('leaves AgentRunContext.principal undefined on the direct dispatch branch when options omits it, behaving exactly as before this field existed', async () => {
      let sawContextPrincipal: string | undefined = 'not-yet-observed';
      const capturingAgent: RunnableAgent = {
        name: 'capturing',
        hasOutput: false,
        run: (input, context) => {
          sawContextPrincipal = context?.principal;
          return createAgent({ generate: mockGenerate('captured') }).run(input, context);
        },
      };
      const bureau = await createBureau({ agents: { capturing: capturingAgent } });
      try {
        const run = bureau.run('capturing', 'hi');
        await run.result();
        expect(sawContextPrincipal).toBeUndefined();
      } finally {
        await bureau.dispose();
      }
    });

    it("records options.principal as the durable ActiveRun's LivenessSnapshot.owner, exactly as Bureau.createRun records request.principal", async () => {
      const bureau = await createBureau({
        agents: { echo: createAgent({ generate: mockGenerate('durable hello') }) },
        storage: { type: 'memory' },
        durableExecution: true,
      });
      try {
        const run = bureau.run('echo', 'hi', { principal: 'alice' });
        await run.result();
        // Checked AFTER settlement: `bureau.run`'s durable branch resolves
        // the underlying ActiveRun asynchronously (`OPERATIVE_RESOLVE_RUN_OPTIONS`
        // is awaited before `createActiveRun` runs), so `snapshot()` reports
        // a synthetic pending snapshot with no `owner` immediately after
        // this call returns — `owner` is a fixed part of every snapshot the
        // real underlying ActiveRun produces, including its terminal one.
        expect(run.snapshot().owner).toBe('alice');
      } finally {
        await bureau.dispose();
      }
    });

    it("leaves the durable ActiveRun's LivenessSnapshot.owner absent when options omits principal, matching a standalone run", async () => {
      const bureau = await createBureau({
        agents: { echo: createAgent({ generate: mockGenerate('durable hello') }) },
        storage: { type: 'memory' },
        durableExecution: true,
      });
      try {
        const run = bureau.run('echo', 'hi');
        await run.result();
        expect(run.snapshot().owner).toBeUndefined();
      } finally {
        await bureau.dispose();
      }
    });

    it('still forwards options.principal to AgentRunContext.principal when a durable bureau falls back to direct execution for a non-resolving agent', async () => {
      // The durable branch records `runAttribution` under the durable
      // dispatch's OWN minted `runId` before the `AgentContractError`
      // fallback runs — this run never uses that id (the agent's own
      // `run()` mints/owns a different one), so the fallback catch deletes
      // that entry to avoid a permanent phantom. `context.principal` must
      // still reach the agent either way.
      let sawContextPrincipal: string | undefined;
      const nonResolvingAgent: RunnableAgent = {
        name: 'plain',
        hasOutput: false,
        run: (input, context) => {
          sawContextPrincipal = context?.principal;
          return createAgent({ generate: mockGenerate('plain hello') }).run(input, context);
        },
      };
      const bureau = await createBureau({
        agents: { plain: nonResolvingAgent },
        storage: { type: 'memory' },
        durableExecution: true,
      });
      try {
        const run = bureau.run('plain', 'hi', { principal: 'alice' });
        const result = await run.result();
        expect(result.content).toBe('plain hello');
        expect(sawContextPrincipal).toBe('alice');
      } finally {
        await bureau.dispose();
      }
    });
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

  it('completes dispose() teardown (toolbox/storage) even when an in-flight catalog run throws from abort()', async () => {
    // Review round 2 (Codex): dispose() must isolate a failing catalog
    // run's abort() so the unconditional teardown after it (toolbox
    // shutdown, durable-engine disposal, storage closure) still runs — a
    // rejection here would otherwise be cached forever as disposePromise,
    // permanently blocking cleanup on every subsequent dispose() call too.
    const hostileAgent: RunnableAgent<unknown, boolean> = {
      name: 'hostile',
      hasOutput: false,
      run: () =>
        ({
          result: () => new Promise<never>(() => {}), // never settles
          unwrap: () => {
            throw new Error('not used by this test');
          },
          abort: () => {
            throw new Error('a hostile agent throwing from abort()');
          },
          [Symbol.dispose]: () => {},
          [Symbol.asyncIterator]: () => {
            throw new Error('not used by this test');
          },
        }) as unknown as AgentRun<unknown, boolean>,
    };
    const bureau = await createBureau({ agents: { hostile: hostileAgent } });
    bureau.run('hostile', 'hi'); // dispatched, never settles, still tracked

    // Must resolve, not hang or reject, despite the hostile abort() above.
    await bureau.dispose();

    // A second call returns the same cached, already-resolved promise
    // rather than re-running (and re-throwing) teardown.
    await bureau.dispose();
  });

  it("shutdown({ policy: 'drain' }) lets a still-running bureau.run() catalog dispatch reach its own natural terminal result instead of aborting it (AB-207)", async () => {
    // The 'abort' policy's catalog-run handling (`for (const catalogRun of
    // [...catalogRuns]) catalogRun.abort(...)`) is covered by the hostile-
    // agent test above. 'drain' takes the OTHER branch instead —
    // `runTerminals.push(Promise.allSettled([catalogRun.result()]))` — which
    // this test is the only coverage for: a gated (not hostile) catalog
    // agent whose `result()` only settles once the test releases it.
    let releaseAgent!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    let aborted = false;
    const gatedAgent: RunnableAgent<unknown, boolean> = {
      name: 'gated',
      hasOutput: false,
      run: () =>
        ({
          result: async () => {
            await gate;
            return { content: 'done', toolCalls: [] };
          },
          unwrap: () => {
            throw new Error('not used by this test');
          },
          abort: () => {
            aborted = true;
          },
          [Symbol.dispose]: () => {},
          [Symbol.asyncIterator]: () => {
            throw new Error('not used by this test');
          },
        }) as unknown as AgentRun<unknown, boolean>,
    };
    const bureau = await createBureau({ agents: { gated: gatedAgent } });

    const run = bureau.run('gated', 'hi');

    let shutdownSettled = false;
    const shutdownPromise = bureau.shutdown({ policy: 'drain' }).then((report) => {
      shutdownSettled = true;
      return report;
    });

    // Still gated — 'drain' must not have aborted the catalog run, and
    // shutdown() has not resolved while it is still in flight.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(aborted).toBe(false);
    expect(shutdownSettled).toBe(false);

    releaseAgent();
    await run.result();

    await shutdownPromise;
    expect(shutdownSettled).toBe(true);
    expect(aborted).toBe(false);
  });

  it('snapshots agents before the first await — a caller mutating the same object after calling createBureau() does not leak into bureau.agents', async () => {
    // Review round 2 (Codex): createRuntimeComposition(options) used to be
    // awaited BEFORE the catalog was built from options.agents, leaving a
    // real mutation window. createBureau() is an async function: it runs
    // synchronously up to its first `await`, so if the snapshot happens
    // before that point (the fix), a caller's mutation on the very next
    // line — necessarily AFTER createBureau() has already returned control
    // — can never affect it, regardless of how many microtask hops
    // composition itself takes.
    const agents: Record<string, RunnableAgent<unknown, boolean>> = {
      echo: createAgent({ generate: mockGenerate() }),
    };
    const bureauPromise = createBureau({ agents });
    agents['mutated'] = createAgent({ generate: mockGenerate() });
    delete agents['echo'];

    const bureau = await bureauPromise;
    try {
      expect(bureau.agents.names()).toEqual(['echo']);
      expect(bureau.agents.has('mutated')).toBe(false);
    } finally {
      await bureau.dispose();
    }
  });
});

describe('Bureau invariants on catalog-agent dispatch (COR-1265, COR-1277)', () => {
  // A catalog agent resolves its own provider, toolbox, memory and skills
  // (AB-240), so Bureau's tier can only reach it where an options bag exists
  // outside the agent to merge into. COR-1277 made that true of every dispatch
  // whose agent exposes `OPERATIVE_RESOLVE_RUN_OPTIONS`, durable or not, so
  // `durableExecution` is no longer part of the answer — only the resolver is.
  //
  // Observed behaviorally rather than by introspection: `AgentRun` exposes no
  // `describeHookPlan` (that is on `ActiveRun`), and behavior is the stronger
  // assertion anyway. `bureau:identity` appends its system message on step 0,
  // and a tripped guardrail halts the run, so a generate that sees the message
  // and a run that halts are both runs whose plan composed Bureau's tier.
  function captureSystemMessages(seen: string[]) {
    return async (request: { conversation?: { getMessages?: () => readonly unknown[] } }) => {
      const messages = request.conversation?.getMessages?.() ?? [];
      for (const message of messages as ReadonlyArray<{ role?: string; content?: unknown }>) {
        if (message.role === 'system' && typeof message.content === 'string') {
          seen.push(message.content);
        }
      }
      return { content: 'ok', toolCalls: [] };
    };
  }

  /** A detector that always trips, so the assertion is about composition and not about detection. */
  const alwaysTrip = {
    mode: 'tripwire' as const,
    input: {
      detectors: [
        {
          name: 'always-trip',
          detect: async () => ({ triggered: true, confidence: 1, category: 'test' }),
        },
      ],
    },
  };

  it('applies them to a durably dispatched catalog agent', async () => {
    const seen: string[] = [];
    const bureau = await createBureau({
      agents: {
        echo: createAgent({
          generate: captureSystemMessages(seen),
        }),
      },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
      durableExecution: true,
    });

    try {
      await bureau.run('echo', 'hi').result();
      expect(seen).toContain('You are the house agent.');
    } finally {
      await bureau.dispose();
    }
  });

  // COR-1277 criterion 13. The case the whole issue exists for: a bureau that
  // was simply not built durable, dispatching an ordinary `createAgent` result.
  it('applies them to a NON-durable dispatch of a resolver-capable agent', async () => {
    const seen: string[] = [];
    const bureau = await createBureau({
      agents: { echo: createAgent({ name: 'echo', generate: captureSystemMessages(seen) }) },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
    });

    try {
      const result = await bureau.run('echo', 'hi').result();
      expect(seen).toContain('You are the house agent.');
      // Not vacuous, and not a run that merely failed early: it completed with
      // the agent's own answer.
      expect(result.content).toBe('ok');
    } finally {
      await bureau.dispose();
    }
  });

  it('applies the guardrail tier to a NON-durable dispatch, not just identity', async () => {
    let generateCalls = 0;
    const bureau = await createBureau({
      agents: {
        echo: createAgent({
          name: 'echo',
          generate: async () => {
            generateCalls += 1;
            return { content: 'ok', toolCalls: [] };
          },
        }),
      },
      guardrails: alwaysTrip,
      storage: { type: 'memory' },
    });

    try {
      const result = await bureau.run('echo', 'hi').result();
      // `bureau:guardrails-prepare-step` runs before generate and hard-halts,
      // so the provider is never reached. Identity alone would not prove this —
      // it is a different registration on the same tier.
      expect(result.finishReason).toBe('tripwire');
      expect(generateCalls).toBe(0);
    } finally {
      await bureau.dispose();
    }
  });

  it('leaves the agent’s own provider and toolbox in place on a NON-durable dispatch', async () => {
    // AB-240's rollback trigger. Bureau contributes a hook tier and nothing
    // else: the answer still comes from the agent's own generate, not from any
    // Bureau default — this bureau has none to fall back to.
    const bureau = await createBureau({
      agents: {
        echo: createAgent({
          name: 'echo',
          generate: async () => ({ content: 'from the agent', toolCalls: [] }),
        }),
      },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
    });

    try {
      const result = await bureau.run('echo', 'hi').result();
      expect(result.content).toBe('from the agent');
    } finally {
      await bureau.dispose();
    }
  });

  // COR-1277 criterion 2. The load-bearing design claim: `createActiveRun` is
  // called from the synthetic agent's `run()`, which `createDeferredAgentRun`
  // invokes only AFTER its `isTerminal()` check. Put it in the resolver instead
  // and this test fails — the run would already have started by the time the
  // abort arrived, which is exactly why the durable branch needs a hundred
  // lines of abort-forwarding machinery that this path does not.
  it('starts no run when an abort arrives during the resolution window', async () => {
    let generateCalls = 0;
    const bureau = await createBureau({
      agents: {
        echo: createAgent({
          name: 'echo',
          generate: async () => {
            generateCalls += 1;
            return { content: 'ok', toolCalls: [] };
          },
        }),
      },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
    });

    try {
      const run = bureau.run('echo', 'hi');
      // Synchronously, before the deferred resolution has had a microtask.
      run.abort('cancelled during resolution');
      await run.result().catch(() => undefined);

      // Drain before asserting. The handle settles synthetically the moment
      // `abort()` lands, so its `result()` resolves without waiting for
      // anything the resolver may still be doing — assert immediately and an
      // ORPHANED run started inside the resolver would not have reached
      // `generate` yet, and this test would pass while leaking one. Verified:
      // moving `createActiveRun` into the resolver makes this fail only with
      // the drain, and pass without it.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(generateCalls).toBe(0);
    } finally {
      await bureau.dispose();
    }
  });

  // COR-1277 criterion 3. `createActiveRun` derives `LivenessSnapshot.owner`
  // from its third argument alone, never from `RunOptions.principal`.
  // `agent.run()` used to supply it internally; now this path builds the run
  // itself and has to pass it, or every principal-carrying non-durable catalog
  // run silently reports no owner.
  it('attributes a NON-durable catalog run to its principal', async () => {
    const bureau = await createBureau({
      agents: { echo: createAgent({ name: 'echo', generate: mockGenerate('ok') }) },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
    });

    try {
      const run = bureau.run('echo', 'hi', { principal: 'api-key:alice' });
      await run.result();
      expect(run.snapshot().owner).toBe('api-key:alice');
    } finally {
      await bureau.dispose();
    }
  });

  // COR-1277 criterion 8. A resolver-capable agent whose resolver REJECTS with
  // `AgentContractError` — the `createLazyAgent` shape, which exposes the
  // symbol unconditionally and only discovers on invocation whether the module
  // behind it supports resolution. Not the no-resolver case, which never
  // reaches this branch.
  it('falls back to the agent’s own run() when its resolver reports no support', async () => {
    let ranThroughOwnRun = false;
    const base = createAgent({ name: 'lazyish', generate: mockGenerate('from own run') });
    const agent: RunnableAgent & DefinitionResolvingAgent = {
      name: base.name,
      hasOutput: base.hasOutput,
      run: (input, context) => {
        ranThroughOwnRun = true;
        return base.run(input, context);
      },
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: () => {
        throw new AgentContractError('definition resolution is not supported', undefined);
      },
    };
    const bureau = await createBureau({
      agents: { lazyish: agent },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
    });

    try {
      const result = await bureau.run('lazyish', 'hi').result();
      expect(result.content).toBe('from own run');
      expect(ranThroughOwnRun).toBe(true);
    } finally {
      await bureau.dispose();
    }
  });

  // COR-1277 criterion 7. A genuine resolver failure settled as it does today.
  // Before this change the same failure happened inside `agent.run()` and
  // `createDeferredAgentRun` classified it "threw synchronously from run()";
  // rethrowing from the resolver instead would reclassify it as a LOAD_FAILED
  // load error, which is a different thing for a caller to branch on.
  it('settles a genuine resolver failure with its existing classification', async () => {
    const base = createAgent({ name: 'broken', generate: mockGenerate() });
    const agent: RunnableAgent & DefinitionResolvingAgent = {
      name: base.name,
      hasOutput: base.hasOutput,
      run: base.run,
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: () => {
        throw new Error('resolution exploded');
      },
    };
    const bureau = await createBureau({
      agents: { broken: agent },
      storage: { type: 'memory' },
    });

    try {
      const run = bureau.run('broken', 'hi'); // must not throw synchronously
      const result = await run.result();
      expect(result.finishReason).not.toBe('stop-condition');
      // The classification, not merely "an error": `run()`-synchronous, which
      // is what a caller sees today, rather than a load failure.
      expect(String(result.error)).toContain('threw synchronously from run()');
    } finally {
      await bureau.dispose();
    }
  });

  // COR-1277 criterion 5. The AB-260 stamp is parity with the durable branch,
  // and its effect is deliberately invisible for an ordinary `createAgent`
  // agent: `buildRunOptions` always populates `runtime`, so the spread leaves
  // the agent's value in place. Only a hand-written resolver that omits the
  // field can reach the stamp at all.
  //
  // What this pins is survivability, not the stamp's effect. Nothing on this
  // dispatch path's public surface reports which `RuntimeServices` instance a
  // run used, so a test asserting the stamp took hold cannot be written here
  // without reaching into internals — stated rather than faked with an
  // assertion that would pass either way.
  it('dispatches a resolver that omits runtime, which is the only shape the stamp reaches', async () => {
    const base = createAgent({ name: 'bare', generate: mockGenerate('bare ok') });
    const agent: RunnableAgent & DefinitionResolvingAgent = {
      name: base.name,
      hasOutput: base.hasOutput,
      run: base.run,
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: async (input, context) => {
        const resolved = await base[OPERATIVE_RESOLVE_RUN_OPTIONS]!(input, context);
        const { runtime: _dropped, ...withoutRuntime } = resolved;
        return withoutRuntime;
      },
    };
    const bureau = await createBureau({
      agents: { bare: agent },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
    });

    try {
      const result = await bureau.run('bare', 'hi').result();
      expect(result.content).toBe('bare ok');
    } finally {
      await bureau.dispose();
    }
  });

  // COR-1277 criterion 9. The residue: the resolver is what this path needs,
  // so an agent exposing none is uncovered whether or not the bureau is
  // durable. Both halves are pinned so the documentation cannot drift back to
  // describing this as a durability question.
  it('cannot reach a durable dispatch of an agent that resolves no run options', async () => {
    const seen: string[] = [];
    const nonResolvingAgent: RunnableAgent = {
      name: 'plain',
      hasOutput: false,
      run: (input, context) =>
        createAgent({ generate: captureSystemMessages(seen) }).run(input, context),
    };
    const bureau = await createBureau({
      agents: { plain: nonResolvingAgent },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
      durableExecution: true,
    });

    try {
      await bureau.run('plain', 'hi').result();
      expect(seen).not.toContain('You are the house agent.');
    } finally {
      await bureau.dispose();
    }
  });

  it('cannot reach a NON-durable dispatch of an agent that resolves no run options', async () => {
    const seen: string[] = [];
    const nonResolvingAgent: RunnableAgent = {
      name: 'plain',
      hasOutput: false,
      run: (input, context) =>
        createAgent({ generate: captureSystemMessages(seen) }).run(input, context),
    };
    const bureau = await createBureau({
      agents: { plain: nonResolvingAgent },
      identity: { resolve: async () => 'You are the house agent.' },
      storage: { type: 'memory' },
    });

    try {
      const result = await bureau.run('plain', 'hi').result();
      expect(result.content).toBe('ok');
      expect(seen).not.toContain('You are the house agent.');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('every Bureau hook hand-off is a merge (COR-1265 criterion 3)', () => {
  // Three of the five sites build `RunOptions` for a handle no public surface
  // returns — `bureau.createRun()` resolves a `RunSummary`, and the scheduler
  // and mocked-reattach paths produce no caller-visible run at all — so
  // `describeHookPlan()` cannot reach them the way it reaches the scheduled and
  // recovered paths tested in `runtime-composition.test.ts`.
  //
  // This is the assertion that does reach all five: no site hands a run the
  // live registry. It is a source invariant rather than a behavior, and it is
  // stated as one rather than dressed up as coverage it is not.
  it('leaves no site handing a run the live runRuntime registry', async () => {
    const sources = ['./create-bureau.ts', './runtime-composition.ts'];
    for (const source of sources) {
      const text = await Bun.file(new URL(source, import.meta.url).pathname).text();
      // The raw hand-off, in any whitespace shape. A match means a run received
      // the registry Bureau keeps mutating instead of a snapshot of it.
      expect(text, source).not.toMatch(/hooks:\s*runRuntime\.hooks\b/u);
      expect(text, source).not.toMatch(/hooks:\s*registerTrailingOnStep\(/u);
    }
  });

  it('carries Bureau’s tier into an interactive bureau.createRun run', async () => {
    const seen: string[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: async (request) => {
        for (const message of request.conversation.getMessages()) {
          if (message.role === 'system' && typeof message.content === 'string') {
            seen.push(message.content);
          }
        }
        return { content: 'ok', toolCalls: [] };
      },
      identity: { resolve: async () => 'BUREAU-TIER-REACHED' },
      storage: { type: 'memory' },
    });

    try {
      const run = await bureau.createRun({ message: 'hi' });
      for (let attempt = 0; attempt < 50 && seen.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(bureau.getRun(run.id)).toBeDefined();
      expect(seen).toContain('BUREAU-TIER-REACHED');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('a child run is outside Bureau’s hook authority (COR-1269)', () => {
  it('does not carry the dispatching Bureau’s invariants into a child run', async () => {
    const supervisorSaw: string[] = [];
    const childSaw: string[] = [];
    function recordInto(seen: string[]) {
      return async (request: {
        conversation: { getMessages: () => ReadonlyArray<{ role?: string; content?: unknown }> };
      }) => {
        for (const message of request.conversation.getMessages()) {
          if (message.role === 'system' && typeof message.content === 'string') {
            seen.push(message.content);
          }
        }
        return { content: 'done', toolCalls: [] };
      };
    }

    const child = createAgent({ name: 'researcher', generate: recordInto(childSaw) });
    const delegate = createSubagentTool({
      name: 'delegate',
      description: 'Delegate',
      agent: child,
      agentName: 'researcher',
      input: z.object({ q: z.string() }),
    });

    let step = 0;
    const bureau = await createBureau({
      agents: {
        supervisor: createAgent({
          name: 'supervisor',
          toolbox: createToolbox([delegate]),
          generate: async (request) => {
            const settled = await recordInto(supervisorSaw)(request);
            return step++ === 0
              ? {
                  content: '',
                  toolCalls: [{ id: 'c1', name: 'delegate', arguments: { q: 'hi' } }],
                }
              : settled;
          },
        }),
      },
      identity: { resolve: async () => 'BUREAU-IDENTITY' },
      storage: { type: 'memory' },
      durableExecution: true,
    });

    try {
      await bureau.run('supervisor', 'go').result();

      // The supervisor is Bureau-owned and carries the invariant. Its child does
      // not, and cannot: `dispatchChildRun` calls `agent.run()`, which builds
      // its `RunOptions` inside the agent, so there is no options bag for a
      // Bureau tier to be merged into — structurally the same gap as the two
      // catalog rows above, closed only by a caller-facing hook field that
      // COR-567 Decision 4 declines.
      //
      // Pinned rather than left implicit. COR-1269's criterion 1 originally
      // claimed a child of a Bureau-owned agent DOES receive that child's
      // Bureau invariants; it was amended to match reality once this was
      // verified by probe. If this ever starts failing, the gap closed: delete
      // the test and update the child section of
      // `documentation/hierarchical-hook-composition.md`.
      expect(supervisorSaw).toContain('BUREAU-IDENTITY');
      expect(childSaw).not.toContain('BUREAU-IDENTITY');
    } finally {
      await bureau.dispose();
    }
  });
});
