import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import { makeContext } from '../routing/strategies/test-helpers.ts';
import { classifyProviderError } from './classify-error.ts';
import { createFalloverGenerate } from './create-fallover-generate.ts';
import { FalloverExhaustedError } from './errors.ts';
import { createProviderHealthTracker } from './provider-health.ts';
import type { FalloverProvider } from './types.ts';

function okProvider(name: string, content = `${name}-response`): FalloverProvider {
  return {
    name,
    generate: async () => ({ content, toolCalls: [] }),
  };
}

function failingProvider(name: string, error: unknown): FalloverProvider {
  return {
    name,
    generate: async () => {
      throw error;
    },
  };
}

function httpError(status: number, message = 'provider error'): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = status;
  return error;
}

describe('createFalloverGenerate', () => {
  it("returns the first available provider's response", async () => {
    const generate = createFalloverGenerate({
      providers: [okProvider('primary')],
    });

    const result = await generate(makeContext());

    expect(result.content).toBe('primary-response');
  });

  it('falls over to the next provider on an auth error, without retrying the failed one', async () => {
    let primaryCalls = 0;
    const primary: FalloverProvider = {
      name: 'primary',
      generate: async () => {
        primaryCalls++;
        throw httpError(401);
      },
    };
    let falloverEvents = 0;
    const generate = createFalloverGenerate({
      providers: [primary, okProvider('secondary')],
      onFallover: () => {
        falloverEvents++;
      },
    });

    const result = await generate(makeContext());

    expect(result.content).toBe('secondary-response');
    expect(primaryCalls).toBe(1);
    expect(falloverEvents).toBe(1);
  });

  it('retries a server-error up to retriesPerProvider, driven entirely by the injected manual runtime', async () => {
    const runtime = createManualRuntimeServices();
    let attempts = 0;
    const flaky: FalloverProvider = {
      name: 'flaky',
      generate: async () => {
        attempts++;
        if (attempts < 3) throw httpError(503);
        return { content: 'recovered', toolCalls: [] };
      },
    };

    const resultPromise = generate_withRetries(flaky, runtime);

    // Two retries needed (attempts 1 and 2 fail); each backs off
    // `retryDelay * 2^(attempt-1)`. Poll the microtask queue (never a real
    // timer) until each backoff timer is armed before advancing past it —
    // matching `run-step.test.ts`'s identical pattern.
    while (attempts < 3) {
      while (runtime.pendingTimers().length === 0) {
        await Promise.resolve();
      }
      await runtime.advance(10_000);
    }

    const result = await resultPromise;
    expect(result.content).toBe('recovered');
    expect(attempts).toBe(3);

    function generate_withRetries(provider: FalloverProvider, runtimeServices: typeof runtime) {
      const generate = createFalloverGenerate({
        providers: [provider],
        retriesPerProvider: 2,
        retryDelay: 10,
        runtime: runtimeServices,
      });
      return generate(makeContext());
    }
  });

  it('throws immediately on an overflow classification without cascading', async () => {
    const overflowError = new Error('context_length_exceeded: too many tokens');
    let secondaryCalls = 0;
    const secondary: FalloverProvider = {
      name: 'secondary',
      generate: async () => {
        secondaryCalls++;
        return { content: 'unused', toolCalls: [] };
      },
    };
    const generate = createFalloverGenerate({
      providers: [failingProvider('primary', overflowError), secondary],
    });

    expect(generate(makeContext())).rejects.toThrow(overflowError);
    expect(secondaryCalls).toBe(0);
  });

  it("throws FalloverExhaustedError with every provider's error when all providers fail", async () => {
    const generate = createFalloverGenerate({
      providers: [
        failingProvider('primary', httpError(401)),
        failingProvider('secondary', httpError(403)),
      ],
    });

    const error = await generate(makeContext()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FalloverExhaustedError);
    expect((error as InstanceType<typeof FalloverExhaustedError>).errors).toHaveLength(2);
  });

  it('reports recovery once a previously-failed provider succeeds again', async () => {
    let attempt = 0;
    const recovering: FalloverProvider = {
      name: 'recovering',
      generate: async () => {
        attempt++;
        if (attempt === 1) throw httpError(401);
        return { content: 'back', toolCalls: [] };
      },
    };
    const recoveries: string[] = [];
    const runtime = createManualRuntimeServices();
    const generate = createFalloverGenerate({
      providers: [recovering, okProvider('fallback')],
      onRecovery: (name) => recoveries.push(name),
      runtime,
    });

    await generate(makeContext());
    // The 401 put `recovering` on cooldown (default 300_000ms) — advance the
    // manual clock past it so the second call is eligible to try `recovering`
    // again, entirely without a real timer.
    await runtime.advance(300_001);
    const second = await generate(makeContext());

    expect(second.content).toBe('back');
    expect(recoveries).toEqual(['recovering']);
  });

  it('rejects immediately when the context signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const generate = createFalloverGenerate({ providers: [okProvider('primary')] });

    expect(generate(makeContext({ signal: controller.signal }))).rejects.toThrow(/aborted/i);
  });

  it('aborts an in-progress retry backoff when the signal fires mid-sleep', async () => {
    const runtime = createManualRuntimeServices();
    const controller = new AbortController();
    let attempts = 0;
    const alwaysFails: FalloverProvider = {
      name: 'flaky',
      generate: async () => {
        attempts++;
        throw httpError(503);
      },
    };
    const generate = createFalloverGenerate({
      providers: [alwaysFails],
      retriesPerProvider: 3,
      retryDelay: 1000,
      runtime,
    });

    const resultPromise = generate(makeContext({ signal: controller.signal }));
    // Give the first attempt's rejection a microtask to register its retry
    // sleep before aborting mid-backoff — no real timer involved.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    expect(resultPromise).rejects.toThrow(/aborted/i);
    expect(attempts).toBe(1);
  });

  it('rejects immediately from sleep() itself when the signal is already aborted at backoff time', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const alwaysFails: FalloverProvider = {
      name: 'flaky',
      generate: async () => {
        attempts++;
        // Aborts during attempt 1, before it throws — with a NON-zero
        // `retryDelay`, the retry loop reaches `sleepFunction(delay, signal)`
        // with the signal ALREADY aborted, exercising `sleep()`'s own
        // call-time abort check rather than its abort-event-listener path.
        controller.abort();
        throw httpError(503);
      },
    };
    const generate = createFalloverGenerate({
      providers: [alwaysFails],
      retriesPerProvider: 3,
      retryDelay: 10,
    });

    const error = await generate(makeContext({ signal: controller.signal })).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DOMException);
    expect(attempts).toBe(1);
  });

  it('aborts at the top of the next retry attempt when the signal fires between (zero-delay) attempts', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const alwaysFails: FalloverProvider = {
      name: 'flaky',
      generate: async () => {
        attempts++;
        // Aborts from inside attempt 1, after it starts but before the retry
        // loop re-checks the signal at the top of attempt 2 — with
        // `retryDelay: 0` no sleep ever runs between attempts, so this
        // exercises the loop's OWN per-attempt abort check rather than
        // `sleep()`'s.
        if (attempts === 1) controller.abort();
        throw httpError(503);
      },
    };
    const generate = createFalloverGenerate({
      providers: [alwaysFails],
      retriesPerProvider: 3,
      retryDelay: 0,
    });

    const error = await generate(makeContext({ signal: controller.signal })).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DOMException);
    expect(attempts).toBe(1);
  });

  it('skips a provider already on cooldown at the start of a call, recording a diagnostic error', async () => {
    const runtime = createManualRuntimeServices();
    let secondaryCalls = 0;
    let primaryCalls = 0;
    const primary: FalloverProvider = {
      name: 'primary',
      generate: async () => {
        primaryCalls++;
        throw httpError(401);
      },
    };
    const secondary: FalloverProvider = {
      name: 'secondary',
      generate: async () => {
        secondaryCalls++;
        return { content: 'secondary-response', toolCalls: [] };
      },
    };
    // The health tracker is per-`createFalloverGenerate()`-call state, so
    // both calls below MUST reuse the same `generate` function for the
    // cooldown recorded by the first call to apply to the second.
    const generate = createFalloverGenerate({ providers: [primary, secondary], runtime });

    // First call puts `primary` on cooldown (a 401 is a COOLDOWN_CLASSIFICATIONS entry).
    await generate(makeContext());
    expect(primaryCalls).toBe(1);
    expect(secondaryCalls).toBe(1);

    // Second call, still within the cooldown window: `primary` is skipped
    // outright (never invoked again) rather than attempted and failing again.
    const result = await generate(makeContext());

    expect(primaryCalls).toBe(1);
    expect(result.content).toBe('secondary-response');
    expect(secondaryCalls).toBe(2);
  });

  it('skips a cooldown provider mid-chain to find the next AVAILABLE one for the fallover event', async () => {
    const runtime = createManualRuntimeServices();
    const seenNextProviders: string[] = [];
    // `alpha` always fails with a server-error (retryable, NOT a
    // COOLDOWN_CLASSIFICATIONS entry) — it stays "available" (per
    // `isAvailable`, which only checks cooldown) across every call even
    // though it never succeeds, so it can be re-attempted call after call.
    const generate = createFalloverGenerate({
      providers: [
        failingProvider('alpha', httpError(503)),
        failingProvider('beta', httpError(401)),
        okProvider('gamma'),
      ],
      onFallover: (event) => seenNextProviders.push(event.nextProvider),
      retriesPerProvider: 0,
      runtime,
    });

    // First call: alpha fails over to beta (fresh, no skip needed), beta
    // fails over to gamma (fresh, no skip needed) and succeeds. This puts
    // ONLY `beta` on cooldown — `alpha` never cools down.
    await generate(makeContext());
    expect(seenNextProviders).toEqual(['beta', 'gamma']);

    // Second call, same cooldown window: alpha is re-attempted (still
    // "available") and fails again; `findNextAvailable` must now SKIP PAST
    // the still-cooldown `beta` (index 1, condition false, loop continues)
    // to land on `gamma` (index 2) — exercising the loop's fall-through path
    // for the first time, not just an immediate first-index match.
    seenNextProviders.length = 0;
    const result = await generate(makeContext());

    expect(result.content).toBe('gamma-response');
    expect(seenNextProviders).toEqual(['gamma']);
  });

  it('reports no next-available provider on the final fallover when every remaining provider is exhausted', async () => {
    const generate = createFalloverGenerate({
      providers: [
        failingProvider('primary', httpError(401)),
        failingProvider('secondary', httpError(403)),
      ],
    });

    const error = await generate(makeContext()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FalloverExhaustedError);
    // Two providers failed, but only ONE fallover event fires (primary →
    // secondary) — there is no THIRD provider to fall over to after
    // secondary also fails, exercising `findNextAvailable`'s "nothing left"
    // path with no `TaskFailedEvent`-style callback firing for it.
    expect((error as InstanceType<typeof FalloverExhaustedError>).errors).toHaveLength(2);
  });
});

describe('classifyProviderError', () => {
  it('classifies a network-pattern message as network', () => {
    expect(classifyProviderError(new Error('fetch failed: ECONNREFUSED'))).toBe('network');
  });

  it('classifies an error with no recognizable status or pattern as unknown', () => {
    expect(classifyProviderError(new Error('a completely ordinary failure'))).toBe('unknown');
  });

  it('includes a nested Error cause message when classifying', () => {
    const cause = new Error('ETIMEDOUT while connecting');
    const error = new Error('request failed', { cause });
    expect(classifyProviderError(error)).toBe('network');
  });

  it('reads a message property off a non-Error object', () => {
    expect(classifyProviderError({ message: 'ECONNREFUSED talking to upstream' })).toBe('network');
  });

  it('returns unknown for a non-object, non-Error value', () => {
    expect(classifyProviderError('a bare string')).toBe('unknown');
  });
});

describe('createProviderHealthTracker', () => {
  it('reports health snapshots and available providers, reflecting cooldown state', () => {
    let now = 1_000;
    const tracker = createProviderHealthTracker([{ name: 'a' }, { name: 'b' }], {
      now: () => now,
      cooldownDuration: 500,
    });

    tracker.recordFailure('a', 'auth', { code: 401, message: 'nope' });

    const health = tracker.getHealth();
    const aHealth = health.find((h) => h.name === 'a');
    expect(aHealth?.available).toBe(false);
    expect(aHealth?.consecutiveFailures).toBe(1);
    expect(aHealth?.totalFailures).toBe(1);
    expect(aHealth?.lastError).toEqual({ code: 401, message: 'nope', timestamp: 1_000 });

    expect(tracker.getAvailableProviders()).toEqual(['b']);

    now = 1_501; // past the 500ms cooldown
    expect(tracker.getAvailableProviders()).toEqual(['a', 'b']);
    expect(tracker.isAvailable('a')).toBe(true);
    expect(tracker.isAvailable('missing-provider')).toBe(false);
  });
});
