import { describe, expect, it } from 'bun:test';

import { createProviderHealthTracker } from './provider-health.ts';

describe('createProviderHealthTracker', () => {
  const providers = [{ name: 'anthropic' }, { name: 'openai' }];

  it('shows all providers as available initially', () => {
    const tracker = createProviderHealthTracker(providers);
    const health = tracker.getHealth();

    expect(health).toHaveLength(2);
    expect(health[0]!.name).toBe('anthropic');
    expect(health[0]!.available).toBe(true);
    expect(health[0]!.consecutiveFailures).toBe(0);
    expect(health[1]!.name).toBe('openai');
    expect(health[1]!.available).toBe(true);
  });

  it('returns all providers from getAvailableProviders initially', () => {
    const tracker = createProviderHealthTracker(providers);
    const available = tracker.getAvailableProviders();
    expect(available).toEqual(['anthropic', 'openai']);
  });

  it('puts a provider on cooldown after an auth failure', () => {
    const tracker = createProviderHealthTracker(providers, { cooldownDuration: 300_000 });
    tracker.recordFailure('anthropic', 'auth', { code: 401, message: 'Unauthorized' });

    const health = tracker.getHealth();
    const anthropic = health.find((h) => h.name === 'anthropic')!;
    expect(anthropic.available).toBe(false);
    expect(anthropic.consecutiveFailures).toBe(1);
    expect(anthropic.totalFailures).toBe(1);
    expect(anthropic.cooldownUntil).toBeDefined();
  });

  it('excludes cooldown provider from getAvailableProviders', () => {
    const tracker = createProviderHealthTracker(providers, { cooldownDuration: 300_000 });
    tracker.recordFailure('anthropic', 'auth', { code: 401, message: 'Unauthorized' });

    const available = tracker.getAvailableProviders();
    expect(available).toEqual(['openai']);
  });

  it('resets consecutive failures and cooldown on success', () => {
    const tracker = createProviderHealthTracker(providers, { cooldownDuration: 300_000 });
    tracker.recordFailure('openai', 'auth', { code: 401, message: 'Unauthorized' });

    // Verify it's on cooldown
    expect(tracker.getAvailableProviders()).toEqual(['anthropic']);

    // Success resets
    tracker.recordSuccess('openai');
    expect(tracker.getAvailableProviders()).toEqual(['anthropic', 'openai']);

    const health = tracker.getHealth();
    const openai = health.find((h) => h.name === 'openai')!;
    expect(openai.consecutiveFailures).toBe(0);
    expect(openai.cooldownUntil).toBeUndefined();
    expect(openai.available).toBe(true);
  });

  it('expires cooldown after duration passes', () => {
    const tracker = createProviderHealthTracker(providers, {
      cooldownDuration: 100,
      now: () => 1000,
    });
    tracker.recordFailure('anthropic', 'auth', { code: 401, message: 'Unauthorized' });

    // Still on cooldown at t=1050
    expect(tracker.isAvailable('anthropic', 1050)).toBe(false);

    // Cooldown expired at t=1101
    expect(tracker.isAvailable('anthropic', 1101)).toBe(true);
  });

  it('tracks providers independently', () => {
    const tracker = createProviderHealthTracker(providers);
    tracker.recordFailure('anthropic', 'server-error', { code: 500, message: 'Internal' });

    const health = tracker.getHealth();
    const anthropic = health.find((h) => h.name === 'anthropic')!;
    const openai = health.find((h) => h.name === 'openai')!;

    expect(anthropic.consecutiveFailures).toBe(1);
    expect(openai.consecutiveFailures).toBe(0);
  });

  it('increments totalCalls on both success and failure', () => {
    const tracker = createProviderHealthTracker(providers);
    tracker.recordSuccess('anthropic');
    tracker.recordSuccess('anthropic');
    tracker.recordFailure('anthropic', 'server-error', { code: 500, message: 'Internal' });

    const health = tracker.getHealth();
    const anthropic = health.find((h) => h.name === 'anthropic')!;
    expect(anthropic.totalCalls).toBe(3);
    expect(anthropic.totalFailures).toBe(1);
  });

  it('does not put provider on cooldown for server-error', () => {
    const tracker = createProviderHealthTracker(providers, { cooldownDuration: 300_000 });
    tracker.recordFailure('openai', 'server-error', { code: 500, message: 'Internal' });

    const health = tracker.getHealth();
    const openai = health.find((h) => h.name === 'openai')!;
    expect(openai.available).toBe(true);
    expect(openai.cooldownUntil).toBeUndefined();
    expect(openai.consecutiveFailures).toBe(1);
  });

  it('puts provider on cooldown for rate-limit failure', () => {
    const tracker = createProviderHealthTracker(providers, { cooldownDuration: 60_000 });
    tracker.recordFailure('anthropic', 'rate-limit', { code: 429, message: 'Rate limited' });

    expect(tracker.getAvailableProviders()).toEqual(['openai']);
  });

  it('stores lastError on failure', () => {
    const tracker = createProviderHealthTracker(providers, { now: () => 5000 });
    tracker.recordFailure('anthropic', 'server-error', {
      code: 503,
      message: 'Service Unavailable',
    });

    const health = tracker.getHealth();
    const anthropic = health.find((h) => h.name === 'anthropic')!;
    expect(anthropic.lastError).toEqual({
      code: 503,
      message: 'Service Unavailable',
      timestamp: 5000,
    });
  });
});
