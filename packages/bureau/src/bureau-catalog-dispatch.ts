import { mergeHookRegistries, type RuntimeServices } from '@lostgradient/lifecycle';
import type {
  ActiveRun,
  AgentInput,
  AgentRun,
  AgentRunContext,
  ClosedOptions,
  DefinitionResolvingAgentWithResolver,
  RunnableAgent,
  RunOptions,
} from '@lostgradient/operative';
import {
  AgentContractError,
  createActiveRun,
  createAgentRun,
  createDeferredAgentRun,
  hasDefinitionResolver,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  readGenerationProfile,
} from '@lostgradient/operative';
import type { AgentDefinitions, AnyRunnableAgent, BureauAgentCatalog } from './agent-catalog';
import type { RuntimeComposition } from './runtime-composition';
import type { RunAttribution } from './serialization';
import type { BureauRunOptions } from './types';

type CatalogRunErrorCode = 'CONFLICT' | 'NOT_FOUND';

export interface CatalogDispatcherDependencies {
  readonly agentCatalog: Pick<BureauAgentCatalog<AgentDefinitions>, 'find'>;
  readonly runtime: RuntimeComposition;
  readonly runtimeServices: RuntimeServices;
  readonly getShutdownPromise: () => Promise<unknown> | undefined;
  readonly catalogRuns: Set<AgentRun<unknown, boolean>>;
  readonly runAttribution: Map<string, RunAttribution>;
  readonly detachBestEffortPromise: (promise: Promise<unknown>) => void;
  readonly createBureauError: (message: string, code: CatalogRunErrorCode) => Error;
  readonly validateAgentRunInput: (input: unknown) => void;
  readonly validateBureauRunOptions: (
    options: BureauRunOptions | undefined,
    principal: unknown,
  ) => void;
}

export function createCatalogDispatcher({
  agentCatalog,
  runtime,
  runtimeServices,
  getShutdownPromise,
  catalogRuns,
  runAttribution,
  detachBestEffortPromise,
  createBureauError,
  validateAgentRunInput,
  validateBureauRunOptions,
}: CatalogDispatcherDependencies): {
  runAgent: (
    name: string,
    input: AgentInput,
    runOptions?: BureauRunOptions,
  ) => AgentRun<unknown, boolean>;
} {
  function trackCatalogRun(handle: AgentRun<unknown, boolean>): AgentRun<unknown, boolean> {
    catalogRuns.add(handle);
    // `detachBestEffortPromise`, not a bare `void ... .finally(...)`: AB-15's
    // contract says a well-behaved `RunnableAgent.result()` never rejects
    // (it settles through `RunResult.error` instead), but "JavaScript
    // callers" is itself one of this issue's acceptance-criteria categories
    // — a foreign, non-conforming agent's `result()` genuinely can reject,
    // and a dropped rejection under `void` would be an unhandled rejection
    // that is this bureau's fault, not the caller's.
    detachBestEffortPromise(
      handle.result().finally(() => {
        catalogRuns.delete(handle);
      }),
    );
    return handle;
  }

  function runDurableCatalogAgent(
    name: string,
    input: AgentInput,
    runOptions: BureauRunOptions | undefined,
    context: AgentRunContext,
    principal: string | undefined,
    agent: AnyRunnableAgent & DefinitionResolvingAgentWithResolver,
  ): AgentRun<unknown, boolean> {
    const durable = runtime.durable;
    if (!durable) {
      throw createBureauError('Durable runtime unavailable', 'CONFLICT');
    }
    const runId = runtimeServices.identifiers.next('agent-run');
    // AB-241 — recorded BEFORE any async work, mirroring
    // `createRunFromRequest`'s own `runAttribution.set` (it writes before
    // `store.register` so it's in place before any observer can see this
    // run). Review finding: cleaned up ONLY when this minted `runId` is
    // abandoned before it ever actually dispatches — the `AgentContractError`
    // fallback and the non-`AgentContractError` resolver-failure catch
    // below, both because an attribution entry keyed to a run that never
    // existed would otherwise be a permanent phantom. A run that DOES
    // dispatch and settle keeps its attribution indefinitely (see
    // `trackCatalogRun`'s own doc comment) — it is not cleaned up here.
    if (principal !== undefined) {
      runAttribution.set(runId, { agentName: name, principal });
    }
    // Captured so the wrapper below can forward an abort straight to the
    // dispatched durable `ActiveRun` even in the race `createDeferredAgentRun`
    // does not close: `resolveDurableAgent` unconditionally starts the
    // durable engine dispatch (it has no way to observe the outer handle's
    // already-terminal state — `createDeferredAgentRun` checks that only
    // AFTER awaiting this resolver, and only to decide whether to call the
    // synthetic agent's `run()`, not whether to have started it). A caller
    // that calls `.abort()` on the returned handle before this resolver's
    // `await resolver(...)` settles would otherwise leave the already-started
    // durable workflow running, unobserved, forever.
    let dispatchedActiveRun: ActiveRun | undefined;
    // Review round 2 (Codex): the previous fix only forwarded abort() to
    // `dispatchedActiveRun` when it ALREADY existed at the moment abort()
    // ran — it did nothing when abort() was called (or the handle
    // disposed) while `resolver(input, context)` was still pending, since
    // `dispatchedActiveRun` is undefined for that entire window and
    // nothing re-checks after it's finally assigned. Remember the request
    // instead, and act on it the instant the ActiveRun exists, whichever
    // order the two events happen in.
    let cancellationRequested: { reason: string | undefined; dispose: boolean } | undefined;
    // AB-291 (AC4): the durable `ActiveRun`'s own `closed()` acknowledgement
    // for a cancellation FORWARDED here (below, once `dispatchedActiveRun`
    // exists) — set the instant that forward runs. `guardedRun.closed()`
    // (below `deferredRun`) must await this, not `deferredRun.closed()`
    // alone: `createDeferredAgentRun`'s own abort handling settles its
    // synthetic `result()` — and therefore its `closed()` — IMMEDIATELY
    // when `abort()` arrives before its resolver has settled (the shared
    // async work is deliberately left running in the background,
    // uncancelled, matching `createLazyAgent`'s module-load precedent).
    // Left alone, `guardedRun.closed()` would report `completed` before
    // the durable engine dispatch this forward targets has even started,
    // let alone been cleaned up.
    // Typed off `ActiveRun['closed']`'s own return, not this file's
    // locally-imported `CleanupAcknowledgement` (bureau's distinct
    // `BureauShutdownReport` string-status vocabulary, shadowing
    // operative's `{ status, reason?, error? }` object shape that
    // `ActiveRun.closed()` actually returns).
    let cancellationForward: ReturnType<ActiveRun['closed']> | undefined;
    // Resolves once `resolveDurableAgent` itself has settled (success,
    // fallback, or throw) — i.e. once `cancellationForward` above has its
    // final value (set or not). `guardedRun.closed()` gates on this before
    // reading `cancellationForward`, so it never reads it too early.
    let dispatchSettled: (() => void) | undefined;
    const dispatchSettledPromise = new Promise<void>((resolve) => {
      dispatchSettled = resolve;
    });
    // `createDeferredAgentRun` resolves a `RunnableAgent` then calls its
    // `run()` — built for `createLazyAgent`'s "resolve a module" case, but
    // agnostic to WHY resolution is async. Wrapping the durable-engine
    // handle (already fully built by the time this resolver settles) in a
    // one-shot synthetic agent reuses its buffering/abort-forwarding
    // machinery instead of reimplementing it.
    const resolveDurableAgent = async (): Promise<RunnableAgent<unknown, boolean>> => {
      let resolvedOptions: RunOptions;
      try {
        // Invoked through `definitionResolvingAgent`, not as a bare
        // extracted `resolver(...)` call — a resolver implemented as a
        // method reading instance state via `this` (a custom
        // `DefinitionResolvingAgent`, not necessarily `createAgent`'s own
        // arrow-function implementation) would otherwise lose its receiver
        // under strict-mode ESM. Matches `createLazyAgent`'s own resolver
        // forwarding for the same reason.
        resolvedOptions = await agent[OPERATIVE_RESOLVE_RUN_OPTIONS](input, context);
        // AB-260: a catalog agent's own resolver builds its RunOptions
        // independently of `runtime.createRunRuntime` (AB-240's dispatch
        // path), so without this it would fall back to operative's OWN
        // default RuntimeServices rather than this bureau's composed
        // instance — breaking "two bureaus in one process never share a
        // clock" for catalog-dispatched runs. Never overrides a resolver
        // that deliberately set its own `runtime`.
        resolvedOptions = { runtime: runtimeServices, ...resolvedOptions };
        // COR-1265 criterion 3b. The agent's own tier is already inside
        // `resolvedOptions.hooks`, from its own `buildRunOptions`. Bureau's
        // invariants — identity and both guardrails, the registrations that
        // close over nothing run-specific — go in front of it, so a durably
        // dispatched catalog run is governed by the same policy every other
        // dispatch shape is. AB-240's separation is untouched: this adds a hook
        // tier, not a provider, a toolbox or a generate.
        resolvedOptions = {
          ...resolvedOptions,
          hooks: mergeHookRegistries(runtime.createBureauInvariantHooks(), resolvedOptions.hooks),
        };
      } catch (error) {
        // Review round 2 (Codex): `typeof resolver === 'function'` above
        // is true for EVERY `createLazyAgent`-wrapped agent unconditionally
        // — the wrapper always exposes this symbol as a proxy that only
        // discovers, once actually invoked, whether the module it loads
        // supports durable resolution at all. A lazy-wrapped agent whose
        // real underlying agent does NOT support it would otherwise always
        // be routed into this durable branch and fail here, even though
        // the exact same agent registered eagerly correctly falls back to
        // direct dispatch (see the "falls back to direct execution" test
        // above). `AgentContractError` is the established convention this
        // codebase already throws for "this capability is not supported"
        // (both here and inside `createLazyAgent`'s own resolver) — catch
        // exactly that class and fall back to the ORIGINAL catalog agent's
        // own `run()`, matching what direct registration would have done.
        // Anything else is a genuine resolver failure and must propagate.
        if (error instanceof AgentContractError) {
          // AB-241: this fallback abandons `runId` entirely — the agent's
          // own `run()` mints (or is given) a DIFFERENT run identity, so
          // an attribution entry recorded above under `runId` would
          // otherwise be a permanent phantom, keyed to a run that never
          // existed.
          runAttribution.delete(runId);
          return agent;
        }
        throw error;
      }
      // AB-240: persist a recovery record BEFORE starting the durable
      // engine, so a crash immediately after `engine.start` still leaves
      // enough, on the next boot, to reattach this run against the catalog
      // agent's OWN run options rather than the Bureau's default runtime
      // composition — a catalog dispatch has no bureau session to write
      // `lastRunId`/`lastRunStatus` onto (see `resolveRunServices`'s
      // catalog branch in runtime-composition.ts). A write failure here
      // propagates uncaught, same as every other resolver failure in this
      // function — better to fail this run's start than dispatch a durable
      // run with no way to reattach it later.
      await runtime.persistCatalogRunRecoveryRecord(runId, {
        agentName: name,
        // Type-level-only correction (mirrors `agent-catalog.ts`'s own
        // `buildCatalogGenerationProfile` cast): `readGenerationProfile`
        // only reads `agent.generationProfile`, which doesn't depend on
        // `RunnableAgent`'s O/H type parameters, but its parameter type
        // defaults to `RunnableAgent<never, false>`, not structurally
        // assignable from `AnyRunnableAgent`'s `RunnableAgent<any, true>` half.
        definitionRevision: readGenerationProfile(agent).revision,
        input,
        // AB-241 review finding: without this, a durable catalog run that
        // crosses a process restart lost its attribution entirely — the
        // resumed resolver's rebuilt `AgentRunContext` carried no
        // `principal`, and `runAttribution` (in-memory only) started
        // empty on the new process.
        ...(principal !== undefined ? { principal } : {}),
      });
      const activeRun = createActiveRun(
        resolvedOptions,
        {
          engine: durable.engine,
          checkpointStore: durable.checkpointStore,
          runId,
          sessionId: runOptions?.sessionId ?? runId,
        },
        // AB-241 — thread the caller-supplied principal into
        // `LivenessSnapshot.owner`, matching `createRunFromRequest`'s own
        // `request.principal !== undefined ? { owner: request.principal } : undefined`.
        principal !== undefined ? { owner: principal } : undefined,
      );
      dispatchedActiveRun = activeRun;
      if (cancellationRequested) {
        if (cancellationRequested.dispose) {
          activeRun[Symbol.dispose]();
        } else {
          activeRun.abort(cancellationRequested.reason);
        }
        // AB-291 (AC4): the real durable run's own acknowledgement for
        // THIS forwarded cancellation — `guardedRun.closed()` awaits it
        // below instead of the deferred wrapper's synthetic settlement.
        cancellationForward = activeRun.closed();
      }
      const agentRun = createAgentRun<unknown, boolean>(activeRun, {
        hasOutput: resolvedOptions.output !== undefined,
      });
      return { name, hasOutput: resolvedOptions.output !== undefined, run: () => agentRun };
    };
    // AB-291 (AC4): wraps `resolveDurableAgent` purely to signal
    // `dispatchSettledPromise` once it settles — by then
    // `cancellationForward` above has its final value (set if a
    // cancellation was forwarded, left `undefined` otherwise). Never
    // swallows or alters `resolveDurableAgent`'s own result/rejection.
    const trackDispatchSettlement = async (): Promise<RunnableAgent<unknown, boolean>> => {
      try {
        return await resolveDurableAgent();
      } catch (error) {
        // AB-241: `resolveDurableAgent`'s `AgentContractError` fallback
        // (above) already deletes `runAttribution` for the abandoned
        // `runId` on ITS OWN success path (a `return`, not a throw). Any
        // other rejection here — `persistCatalogRunRecoveryRecord`
        // failing, `createActiveRun` throwing synchronously on an
        // unrepresentable `output` schema, a genuine resolver failure —
        // means this run never dispatched either, so the same cleanup
        // applies, mirroring `createRunFromRequest`'s own
        // `runAttribution.delete(runId)` for a run that "never reached
        // `store.register`" (see that catch block, below).
        runAttribution.delete(runId);
        throw error;
      } finally {
        dispatchSettled?.();
      }
    };
    const deferredRun = createDeferredAgentRun(trackDispatchSettlement, input, context, name);
    // AB-291 (AC4): computed once — `dispatchSettledPromise` resolves only
    // after `resolveDurableAgent` has settled, by which point
    // `cancellationForward` (set inside it, above) has its final value.
    // Reading `cancellationForward` lazily inside the `.then` (not
    // captured now) is required: this expression is built before that
    // assignment can possibly have happened yet.
    const closedSettlement: ReturnType<ActiveRun['closed']> = dispatchSettledPromise.then(
      () => cancellationForward ?? deferredRun.closed(),
    );
    // AB-291 (AC4 review finding): `closedSettlement`'s own genuine
    // acknowledgement, captured once it settles — read by `closed()`
    // below BEFORE `options.signal.aborted`, so a caller passing an
    // already-aborted signal AFTER the shared settlement has genuinely
    // resolved still gets the identical cached acknowledgement, per
    // `createClosedAcknowledgement`'s own post-settlement idempotency
    // guarantee ("a repeated call after the underlying cleanup has
    // genuinely settled returns the identical cached acknowledgement
    // object by reference"), rather than manufacturing a fresh
    // `unresolved`/`timed-out` result for a signal that arrived too late
    // to mean anything.
    let cachedAcknowledgement: Awaited<ReturnType<ActiveRun['closed']>> | undefined;
    void closedSettlement.then((acknowledgement) => {
      cachedAcknowledgement = acknowledgement;
      return acknowledgement;
    });
    const guardedRun: AgentRun<unknown, boolean> = {
      ...deferredRun,
      abort(reason?: string): void {
        deferredRun.abort(reason);
        if (dispatchedActiveRun) {
          // No-op if `activeRun.abort()` already ran via the normal
          // `underlying.abort()` forwarding path — `AbortController.abort()`
          // (what `ActiveRun.abort()` calls under the hood) is idempotent.
          dispatchedActiveRun.abort(reason);
        } else if (!cancellationRequested) {
          cancellationRequested = { reason, dispose: false };
        }
      },
      [Symbol.dispose](): void {
        deferredRun[Symbol.dispose]();
        if (dispatchedActiveRun) {
          dispatchedActiveRun[Symbol.dispose]();
        } else if (!cancellationRequested) {
          cancellationRequested = { reason: undefined, dispose: true };
        }
      },
      // AB-291 (AC4): overrides `deferredRun.closed()` (otherwise inherited
      // via the `...deferredRun` spread above) — see `closedSettlement`'s
      // and `cancellationForward`'s doc comments for why the inherited one
      // can report `completed` before a forwarded cancellation's own
      // durable cleanup has even started. `options.signal` bounds THIS
      // caller's own wait only, matching every other `closed()`
      // implementation's per-call signal contract (never writes into the
      // shared `closedSettlement` cache).
      closed(options?: ClosedOptions): ReturnType<ActiveRun['closed']> {
        const signal = options?.signal;
        if (!signal) return closedSettlement;
        // Post-settlement idempotency guarantee: once the shared
        // acknowledgement has genuinely settled, every call — regardless
        // of a per-call signal's state — returns that identical cached
        // object, never a fresh `unresolved`/`timed-out` manufactured
        // from a signal that arrived after the fact.
        if (cachedAcknowledgement) return Promise.resolve(cachedAcknowledgement);
        if (signal.aborted) {
          return Promise.resolve({ status: 'unresolved', reason: 'timed-out' });
        }
        return new Promise((resolve) => {
          let settled = false;
          const onAbort = (): void => {
            if (settled) return;
            settled = true;
            resolve({ status: 'unresolved', reason: 'timed-out' });
          };
          signal.addEventListener('abort', onAbort, { once: true });
          void closedSettlement.then((acknowledgement) => {
            if (settled) return acknowledgement;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(acknowledgement);
            return acknowledgement;
          });
        });
      },
    };
    return trackCatalogRun(guardedRun);
  }

  function prepareCatalogRunContext(
    name: string,
    runOptions: BureauRunOptions | undefined,
  ): { context: AgentRunContext; principal: string | undefined } {
    const capturedRunOptionsPrincipal = runOptions?.principal;
    validateBureauRunOptions(runOptions, capturedRunOptionsPrincipal);
    const context: AgentRunContext = { agentName: name };
    if (runOptions?.signal) context.signal = runOptions.signal;
    if (runOptions?.traceContext !== undefined) context.traceContext = runOptions.traceContext;
    if (runOptions?.withTraceContext) context.withTraceContext = runOptions.withTraceContext;
    if (capturedRunOptionsPrincipal !== undefined) {
      context.principal = capturedRunOptionsPrincipal;
    }
    return { context, principal: capturedRunOptionsPrincipal };
  }

  function runAgent(
    name: string,
    input: AgentInput,
    runOptions?: BureauRunOptions,
  ): AgentRun<unknown, boolean> {
    if (getShutdownPromise()) {
      throw createBureauError('Cannot run an agent: bureau is disposed', 'CONFLICT');
    }
    const agent = agentCatalog.find(name);
    if (!agent) {
      throw createBureauError(`Unknown agent "${name}"`, 'NOT_FOUND');
    }
    validateAgentRunInput(input);

    const { context, principal } = prepareCatalogRunContext(name, runOptions);

    const hasResolver = hasDefinitionResolver(agent);
    if (runtime.durable && hasResolver) {
      return runDurableCatalogAgent(name, input, runOptions, context, principal, agent);
    }

    // Review round 2 (Codex): a hand-written catalog RunnableAgent is a
    // valid entry, and one whose run() throws synchronously during per-run
    // setup must still settle through the returned handle, not escape as a
    // synchronous throw from bureau.run() itself — AB-22's synchronous-throw
    // allowlist is unknown name / disposed / malformed input-options only.
    // `createDeferredAgentRun` already contains exactly this "resolveAgent's
    // run() throws synchronously" handling (built for createLazyAgent's own
    // resolved-module case, agnostic to why); reusing it here for an
    // already-resolved agent avoids duplicating that state machine. The one
    // externally observable cost is that `agent.run()` itself is invoked one
    // microtask later than before — compatible with the contract, which
    // promises a synchronous RETURN of the handle, not synchronous START of
    // the agent's own work.
    return trackCatalogRun(
      createDeferredAgentRun(
        () => resolveInvariantComposedAgent(name, input, context, principal, agent, hasResolver),
        input,
        context,
        name,
      ),
    );
  }

  /**
   * COR-1277 — the agent this non-durable dispatch actually runs: the catalog
   * agent itself when nothing can be composed onto it, and otherwise a
   * one-shot synthetic agent carrying Bureau's invariant tier in front of the
   * agent's own.
   *
   * **Where `createActiveRun` is called is the whole design.** It happens
   * inside the returned agent's `run()`, never here in the resolver.
   * `createDeferredAgentRun` checks `isTerminal()` after this function settles
   * and before calling `run()`, so an abort arriving during resolution settles
   * the handle synthetically and the underlying run never starts. That is why
   * this path needs no counterpart to `runDurableCatalogAgent`'s
   * `dispatchedActiveRun`/`cancellationRequested`/`guardedRun`/`closed()`
   * machinery: the durable branch calls `createActiveRun` inside ITS resolver,
   * before that gate (see the comment above `runDurableCatalogAgent`, which
   * says the gate decides whether to CALL `run()`, "not whether to have
   * started it"), so it has to forward the abort itself. This one does not
   * start anything the gate cannot still prevent.
   */
  async function resolveInvariantComposedAgent(
    name: string,
    input: AgentInput,
    context: AgentRunContext,
    principal: string | undefined,
    agent: AnyRunnableAgent,
    hasResolver: boolean,
  ): Promise<RunnableAgent<unknown, boolean>> {
    // An agent exposing no `OPERATIVE_RESOLVE_RUN_OPTIONS` builds its
    // `RunOptions` entirely inside `run()`, so there is no bag to merge a tier
    // into and nothing here can change that (COR-1276's accepted gap). It runs
    // exactly as it did before this function existed.
    //
    // Handed the caller's already-computed boolean rather than re-running
    // `hasDefinitionResolver` here, because the capability is a GETTER on the
    // agent and re-running the guard would read it a second time. A test pins
    // that read count at one for this path ("reads the resolver capability
    // before the direct-dispatch durability branch"), and a lazily-wrapped
    // agent is entitled to treat a read as meaningful.
    if (!hasResolver) return agent as RunnableAgent<unknown, boolean>;

    let resolvedOptions: RunOptions;
    try {
      // The cast is what the boolean above costs: `hasResolver` carries the
      // narrowing that the guard would have applied, but not in a form the
      // compiler tracks across a parameter. Sound because the caller computed
      // it from this exact agent, immediately before.
      resolvedOptions = await (agent as unknown as DefinitionResolvingAgentWithResolver)[
        OPERATIVE_RESOLVE_RUN_OPTIONS
      ](input, context);
    } catch (error) {
      // Same fallback the durable branch makes, for the same reason: a
      // `createLazyAgent` wrapper exposes this symbol unconditionally and only
      // discovers on invocation whether the module behind it supports durable
      // resolution. `AgentContractError` means "not supported" — fall back to
      // the agent's own `run()`, which is what direct registration would have
      // done. This is NOT the no-resolver case above; that one never gets here.
      if (error instanceof AgentContractError) {
        return agent as RunnableAgent<unknown, boolean>;
      }
      // Any other resolution failure is a genuine one, and it must keep
      // settling as it does today. Before this change the same failure happened
      // inside `agent.run()` and `createDeferredAgentRun` classified it as an
      // `AgentContractError` ("threw synchronously from run()"); rethrowing
      // here instead would reclassify it as a LOAD_FAILED load error. Deferring
      // the throw to `run()` keeps the class the caller already sees.
      return {
        name,
        hasOutput: agent.hasOutput,
        run: () => {
          throw error;
        },
      };
    }

    // AB-260, matching the durable branch: a catalog agent's own resolver
    // builds its options independently of this bureau's composition, so
    // without this it would fall back to operative's default RuntimeServices.
    // Parity rather than a behavior change — `createAgent`'s own
    // `buildRunOptions` always populates `runtime`, so for an ordinary agent
    // the spread below leaves the agent's value in place, and this only bites
    // for a hand-written resolver that omits it.
    resolvedOptions = { runtime: runtimeServices, ...resolvedOptions };

    const merged: RunOptions = {
      ...resolvedOptions,
      // Bureau first, so it wins `runFirst` and — being pinned last — still
      // wins the waterfall. Only the invariants that close over nothing
      // run-specific travel here; see `createBureauInvariantHooks`.
      hooks: mergeHookRegistries(runtime.createBureauInvariantHooks(), resolvedOptions.hooks),
    };
    const hasOutput = merged.output !== undefined;

    return {
      name,
      // The resolved options, not `agent.hasOutput`: the durable branch reads
      // it the same way, so a hand-written agent whose runtime witness
      // disagrees with its own schema cannot mint a mismatched handle.
      hasOutput,
      run: () =>
        createAgentRun<unknown, boolean>(
          createActiveRun(
            merged,
            undefined,
            // `createActiveRun` derives `LivenessSnapshot.owner` from this
            // argument alone, never from `RunOptions.principal`. `agent.run()`
            // supplies it internally today, so omitting it here would silently
            // report `owner: undefined` on every principal-carrying run.
            principal !== undefined ? { owner: principal } : undefined,
          ),
          { hasOutput },
        ),
    };
  }

  return { runAgent };
}
