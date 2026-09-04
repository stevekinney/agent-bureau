import { describe, expect, it } from 'bun:test';

import { createExecutionLifecycle, type EffectiveToolExecutionContext } from '../src';
import { createConcurrencyLimiter } from '../src/utilities/concurrency';

describe('execution lifecycle', () => {
  const maximumTimerDelay = 2_147_483_647;

  it('isolates subscriber failures during initial and activation notifications', () => {
    const lifecycle = createExecutionLifecycle();
    lifecycle.subscribe(() => {
      throw new Error('subscriber failed');
    });

    const handle = lifecycle.begin({
      toolName: 'initial-notification',
      callId: 'initial-notification',
    });
    handle.activate();

    expect(handle.snapshot().state).toBe('active');
  });

  it('isolates subscriber failures while settling and completing the lifecycle', async () => {
    const lifecycle = createExecutionLifecycle();
    lifecycle.subscribe(() => {
      throw new Error('subscriber failed');
    });

    const handle = lifecycle.begin({
      toolName: 'settlement-notification',
      callId: 'settlement-notification',
    });
    const settled = handle.whenSettled();
    handle.activate();
    handle.settle('done');

    await expect(settled).resolves.toMatchObject({ state: 'terminal', result: 'done' });
    await expect(lifecycle.shutdown()).resolves.toMatchObject({ terminal: 1 });
    await expect(lifecycle.complete()).resolves.toBeUndefined();
  });

  function createPrivilegedContext(): EffectiveToolExecutionContext & {
    debugGraph: { nested: { value: string } };
  } {
    return {
      authority: {
        principalId: 'principal-a',
        tenantId: 'tenant-a',
        ownerId: 'owner-a',
        capabilities: ['tools:execute', 'runs:write'],
        authorizationRevision: 'authorization:1',
      },
      audience: 'operator',
      agentId: 'agent-a',
      runId: 'run-a',
      requestId: 'request-a',
      locale: 'en-US',
      deadline: 5000,
      credentials: { token: 'secret' },
      traceContext: { traceparent: 'secret-trace' },
      debugGraph: { nested: { value: 'must-not-retain' } },
      revisions: {
        catalog: 'catalog:1',
        toolbox: 'toolbox:1',
        toolDefinition: 'tool:1',
        policy: 'policy:1',
        approval: 'approval:1',
        redaction: 'redaction:1',
      },
    };
  }

  it('publishes immutable monotonically revisioned snapshots and stable locators', async () => {
    let now = 10;
    const lifecycle = createExecutionLifecycle('owner-1');
    const revisions: number[] = [];
    const unsubscribe = lifecycle.subscribe(({ snapshot }) => revisions.push(snapshot.revision));
    const handle = lifecycle.begin({
      toolName: 'send-email',
      callId: 'call-1',
      parentExecutionId: 'parent-1',
      deadline: 100,
      capacity: 2,
      queuePosition: 1,
      now: () => now,
    });

    const queued = handle.snapshot();
    now = 20;
    handle.activate();
    handle.waiting('provider response');
    handle.streaming();
    handle.activity();
    handle.settle({ ok: true });

    expect(Object.isFrozen(queued)).toBe(true);
    expect(lifecycle.locate(handle.id)).toBe(handle);
    expect(lifecycle.inspect({ ownerId: 'owner-1' })).toHaveLength(1);
    expect(handle.snapshot()).toMatchObject({
      toolName: 'send-email',
      callId: 'call-1',
      ownerId: 'owner-1',
      parentExecutionId: 'parent-1',
      state: 'terminal',
      result: { ok: true },
    });
    expect(revisions).toEqual([1, 2, 3, 4, 5, 6]);
    await expect(handle.whenSettled()).resolves.toEqual(handle.snapshot());
    unsubscribe();
  });

  it('retains full privileged context while live and releases payload graphs after settlement', async () => {
    const lifecycle = createExecutionLifecycle();
    const privilegedContext = createPrivilegedContext();
    const handle = lifecycle.begin({
      toolName: 'sensitive-tool',
      callId: 'sensitive-call',
      privilegedContext,
    });

    handle.activate();
    const liveContext = handle.privilegedSnapshot().context as
      (EffectiveToolExecutionContext & { debugGraph?: unknown }) | undefined;

    expect(liveContext?.credentials).toBe(privilegedContext.credentials);
    expect(liveContext?.traceContext).toBe(privilegedContext.traceContext);
    expect(liveContext?.debugGraph).toBe(privilegedContext.debugGraph);

    handle.settle({ ok: true });
    await lifecycle.shutdown({ policy: 'drain' });

    const terminalContext = handle.privilegedSnapshot().context as
      (EffectiveToolExecutionContext & { debugGraph?: unknown }) | undefined;
    const [inspected] = lifecycle.inspectPrivileged({ callId: 'sensitive-call' });

    expect(terminalContext).toEqual({
      authority: {
        principalId: 'principal-a',
        tenantId: 'tenant-a',
        ownerId: 'owner-a',
        capabilities: ['tools:execute', 'runs:write'],
        authorizationRevision: 'authorization:1',
      },
      audience: 'operator',
      agentId: 'agent-a',
      runId: 'run-a',
      requestId: 'request-a',
      locale: 'en-US',
      deadline: 5000,
      revisions: {
        catalog: 'catalog:1',
        toolbox: 'toolbox:1',
        toolDefinition: 'tool:1',
        policy: 'policy:1',
        approval: 'approval:1',
        redaction: 'redaction:1',
      },
    });
    expect(terminalContext).not.toHaveProperty('credentials');
    expect(terminalContext).not.toHaveProperty('traceContext');
    expect(terminalContext).not.toHaveProperty('debugGraph');
    expect(inspected?.context).toEqual(terminalContext);
  });

  it('releases privileged payload graphs after unresolved cleanup', () => {
    const lifecycle = createExecutionLifecycle();
    const handle = lifecycle.begin({
      toolName: 'uncertain-sensitive-tool',
      callId: 'uncertain-sensitive-call',
      privilegedContext: createPrivilegedContext(),
    });

    handle.cleanup({ status: 'unresolved' });

    const context = handle.privilegedSnapshot().context as
      (EffectiveToolExecutionContext & { debugGraph?: unknown }) | undefined;
    expect(handle.snapshot().state).toBe('unknown-effect');
    expect(context?.authority.principalId).toBe('principal-a');
    expect(context?.revisions.toolDefinition).toBe('tool:1');
    expect(context).not.toHaveProperty('credentials');
    expect(context).not.toHaveProperty('traceContext');
    expect(context).not.toHaveProperty('debugGraph');
  });

  it('composes caller and deadline cancellation without claiming ignored work stopped', () => {
    const caller = new AbortController();
    const scheduled: Array<() => void> = [];
    let currentTime = 0;
    const lifecycle = createExecutionLifecycle('owner-2');
    const handle = lifecycle.begin({
      toolName: 'charge',
      callId: 'call-2',
      signal: caller.signal,
      deadline: 5,
      now: () => currentTime,
      setTimeoutFunction(callback) {
        scheduled.push(callback);
        return 1;
      },
    });
    handle.activate();
    currentTime = 5;
    scheduled[0]!();
    expect(handle.signal.aborted).toBe(true);
    expect(handle.snapshot()).toMatchObject({
      state: 'abort-requested',
      abortSource: 'deadline',
    });
    handle.cleanupPending('callback ignored abort');
    expect(lifecycle.activeExecutions).toBe(1);
    expect(handle.snapshot().state).toBe('cleanup-pending');
    handle.unknownEffect('effect may have committed');
    expect(handle.snapshot().state).toBe('unknown-effect');
    caller.abort('late caller abort');
  });

  it('preserves abort provenance while cleanup is pending', () => {
    const lifecycle = createExecutionLifecycle();
    const handle = lifecycle.begin({ toolName: 'cleanup-race', callId: 'cleanup-race' });
    expect(handle.abort('deadline', 'deadline won')).toBe(true);
    handle.cleanupPending('effect may still be running');
    expect(handle.abort('shutdown', 'owner stopped')).toBe(false);
    expect(handle.snapshot()).toMatchObject({
      state: 'cleanup-pending',
      abortSource: 'deadline',
      abortReason: 'deadline won',
    });
    handle.unknownEffect('effect may have committed');
  });

  it('clears an outstanding deadline timer when execution settles', () => {
    const lifecycle = createExecutionLifecycle();
    const scheduled: Array<() => void> = [];
    const cleared: unknown[] = [];
    const handle = lifecycle.begin({
      toolName: 'timer-cleanup',
      callId: 'timer-cleanup',
      deadline: 10,
      now: () => 0,
      setTimeoutFunction(callback) {
        scheduled.push(callback);
        return 'timer-token';
      },
      clearTimeoutFunction(timer) {
        cleared.push(timer);
      },
    });
    handle.settle('done');
    expect(cleared).toEqual(['timer-token']);
    scheduled[0]!();
    expect(handle.snapshot().state).toBe('terminal');
  });

  it('re-arms long deadline timers instead of scheduling overflow delays', () => {
    let currentTime = 0;
    const scheduled: Array<{ callback: () => void; milliseconds: number }> = [];
    const lifecycle = createExecutionLifecycle();
    const deadline = maximumTimerDelay + 1_000;
    const handle = lifecycle.begin({
      toolName: 'long-deadline',
      callId: 'long-deadline',
      deadline,
      now: () => currentTime,
      setTimeoutFunction(callback, milliseconds) {
        scheduled.push({ callback, milliseconds });
        return scheduled.length;
      },
    });

    expect(scheduled[0]?.milliseconds).toBe(maximumTimerDelay);
    scheduled[0]?.callback();
    expect(handle.signal.aborted).toBe(false);
    expect(handle.snapshot().state).toBe('queued');
    expect(scheduled[1]?.milliseconds).toBe(maximumTimerDelay);

    currentTime = deadline;
    scheduled[1]?.callback();

    expect(handle.signal.aborted).toBe(true);
    expect(handle.snapshot()).toMatchObject({
      state: 'abort-requested',
      abortSource: 'deadline',
      abortReason: 'Execution deadline exceeded',
    });
  });

  it('rejects non-finite execution lifecycle deadlines', () => {
    const lifecycle = createExecutionLifecycle();

    expect(() =>
      lifecycle.begin({
        toolName: 'infinite-deadline',
        callId: 'infinite-deadline',
        deadline: Infinity,
      }),
    ).toThrow('Execution deadline must be finite.');
    expect(lifecycle.inspect()).toHaveLength(0);
  });

  it('closes admission, scopes abort, and returns one idempotent shutdown report', async () => {
    const lifecycle = createExecutionLifecycle('owner-3');
    const first = lifecycle.begin({ toolName: 'alpha', callId: 'a' });
    const second = lifecycle.begin({ toolName: 'beta', callId: 'b' });
    first.activate();
    second.activate();
    expect(lifecycle.abort({ toolName: 'alpha' }, 'stop alpha', 'toolbox')).toBe(1);
    expect(first.snapshot().abortSource).toBe('toolbox');
    expect(second.signal.aborted).toBe(false);
    first.settle();
    second.settle();

    const one = lifecycle.shutdown({ policy: 'drain' });
    const two = lifecycle.shutdown({ policy: 'abort' });
    expect(one).toBe(two);
    await expect(one).resolves.toMatchObject({
      admissionClosed: true,
      policy: 'drain',
      terminal: 2,
      unknownEffects: 0,
    });
    expect(() => lifecycle.begin({ toolName: 'late', callId: 'late' })).toThrow(
      'Execution admission is closed',
    );
  });

  it('supports the compatibility counter, explicit cleanup outcomes, and awaitable completion', async () => {
    const lifecycle = createExecutionLifecycle();
    expect(lifecycle.completed).toBe(false);
    expect(lifecycle.admissionClosed).toBe(false);
    const release = lifecycle.start();
    expect(lifecycle.activeExecutions).toBe(1);
    release();
    release();

    const completed = lifecycle.begin({ toolName: 'cleanup', callId: 'completed' });
    completed.cleanup();
    const failed = lifecycle.begin({ toolName: 'cleanup', callId: 'failed' });
    failed.cleanup({ status: 'failed', error: new Error('listener failed') });
    const unresolved = lifecycle.begin({ toolName: 'cleanup', callId: 'unresolved' });
    unresolved.cleanup({ status: 'unresolved' });
    expect(completed.snapshot().cleanup?.status).toBe('completed');
    expect(failed.snapshot().cleanup?.status).toBe('failed');
    expect(unresolved.snapshot().state).toBe('unknown-effect');

    lifecycle.closeAdmission();
    expect(lifecycle.admissionClosed).toBe(true);
    await lifecycle.complete();
    expect(lifecycle.completed).toBe(true);
  });

  it('rejects work that is already aborted before concurrency admission', async () => {
    const controller = new AbortController();
    controller.abort('already stopped');
    const lifecycle = createExecutionLifecycle();
    const handle = lifecycle.begin({
      toolName: 'pre-aborted',
      callId: 'pre-aborted',
      signal: controller.signal,
    });
    expect(handle.signal.aborted).toBe(true);
    expect(handle.snapshot()).toMatchObject({ state: 'abort-requested', abortSource: 'caller' });
    handle.settle();
  });

  it('rejects already-aborted work before it enters a concurrency limiter', async () => {
    const limiter = createConcurrencyLimiter(1);
    const controller = new AbortController();
    controller.abort('already cancelled');

    await expect(
      limiter?.run(async () => 'unreachable', { signal: controller.signal }),
    ).rejects.toThrow('already cancelled');
  });

  it('keeps terminal states monotonic and counts only new abort requests', () => {
    const lifecycle = createExecutionLifecycle();
    const handle = lifecycle.begin({
      executionId: 'stable-execution',
      toolName: 'stable',
      callId: 'stable-call',
    });
    expect(lifecycle.abort({ executionId: handle.id }, 'first')).toBe(1);
    expect(lifecycle.abort({ executionId: handle.id }, 'duplicate')).toBe(0);
    handle.unknownEffect('unverified');
    const terminalRevision = handle.snapshot().revision;

    handle.activate();
    handle.waiting('late wait');
    handle.streaming();
    handle.cleanupPending('late cleanup');
    handle.settle('late result');

    expect(handle.snapshot()).toMatchObject({
      executionId: 'stable-execution',
      state: 'unknown-effect',
      result: 'late result',
    });
    expect(handle.snapshot().revision).toBe(terminalRevision + 1);
    expect(() =>
      lifecycle.begin({
        executionId: 'stable-execution',
        toolName: 'duplicate',
        callId: 'duplicate',
      }),
    ).toThrow('Execution already exists: stable-execution');
  });

  it('does not abort a settled handle or retain owner abort listeners', async () => {
    const lifecycle = createExecutionLifecycle();
    const settled = lifecycle.begin({ toolName: 'settled', callId: 'settled' });
    settled.settle('done');
    expect(settled.abort('shutdown', 'late')).toBe(false);
    expect(settled.signal.aborted).toBe(false);

    const inFlight = lifecycle.begin({ toolName: 'in-flight', callId: 'in-flight' });
    inFlight.activate();
    inFlight.settle('done');
    await lifecycle.shutdown();
    expect(inFlight.signal.aborted).toBe(false);
    expect(lifecycle.completed).toBe(true);
  });

  it('reports FIFO queue positions without running cancelled work', async () => {
    const limiter = createConcurrencyLimiter(1)!;
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
    const secondPositions: number[] = [];
    const thirdPositions: number[] = [];
    const second = limiter.run(async () => undefined, {
      onQueuePosition: (position) => secondPositions.push(position),
    });
    const thirdController = new AbortController();
    const third = limiter.run(async () => undefined, {
      signal: thirdController.signal,
      onQueuePosition: (position) => thirdPositions.push(position),
    });

    expect(limiter.capacity).toBe(1);
    expect(secondPositions).toEqual([1]);
    expect(thirdPositions).toEqual([2]);
    thirdController.abort('remove third');
    await expect(third).rejects.toThrow('remove third');
    release();
    await Promise.all([first, second]);
  });

  it('continues promoting queued work when a position observer throws', async () => {
    const limiter = createConcurrencyLimiter(1)!;
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
    const started: string[] = [];
    const second = limiter.run(
      async () => {
        started.push('second');
      },
      {
        onQueuePosition: () => {
          throw new Error('observer failed');
        },
      },
    );
    const third = limiter.run(async () => {
      started.push('third');
    });

    release();
    await Promise.all([first, second, third]);
    expect(started).toEqual(['second', 'third']);
  });

  it('removes a queued task when its position observer aborts synchronously', async () => {
    const limiter = createConcurrencyLimiter(1)!;
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
    const controller = new AbortController();
    const queued = limiter.run(async () => 'should not run', {
      signal: controller.signal,
      onQueuePosition: () => controller.abort('observer cancelled'),
    });
    await expect(queued).rejects.toThrow('observer cancelled');
    release();
    await first;
  });

  it('mints independent executionId sequences for two lifecycles in one process (AB-254)', () => {
    // On the baseline, `nextExecutionId` was module-level mutable state
    // shared by every `createExecutionLifecycle()` call in the process, so
    // two lifecycles constructed concurrently drew interleaved counter
    // values from the same source. AB-254 moves the identifier onto each
    // lifecycle's own composed `RuntimeServices` instance, so this fails on
    // the baseline and passes once the counter is per-lifecycle.
    const first = createExecutionLifecycle();
    const second = createExecutionLifecycle();

    const firstHandle = first.begin({ toolName: 'a', callId: 'a-call' });
    const secondHandle = second.begin({ toolName: 'b', callId: 'b-call' });
    const firstSecondHandle = first.begin({ toolName: 'a2', callId: 'a2-call' });
    const secondSecondHandle = second.begin({ toolName: 'b2', callId: 'b2-call' });

    // Independent per-lifecycle identifier sequences: each lifecycle's own
    // first and second execution ids differ from each other and from the
    // other lifecycle's, and neither lifecycle observes the other's ids.
    expect(firstHandle.id).not.toBe(secondHandle.id);
    expect(firstSecondHandle.id).not.toBe(secondSecondHandle.id);
    expect(firstHandle.id).not.toBe(firstSecondHandle.id);
    expect(secondHandle.id).not.toBe(secondSecondHandle.id);
    expect(first.inspect().map((snapshot) => snapshot.executionId)).toEqual([
      firstHandle.id,
      firstSecondHandle.id,
    ]);
    expect(second.inspect().map((snapshot) => snapshot.executionId)).toEqual([
      secondHandle.id,
      secondSecondHandle.id,
    ]);
  });
});
