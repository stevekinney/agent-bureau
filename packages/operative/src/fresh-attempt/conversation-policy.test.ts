import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { createSessionStore } from '../session/create-session-store';
import { ForkThroughRunError, createSessionHandle } from '../session/session-handle';
import { createTestRunOptions } from '../session/session-handle-test-support';
import type { SessionHandle } from '../session/session-handle-types';
import { applyConversationPolicy } from './conversation-policy';
import {
  FIXTURE_NOW,
  createFixtureArtifact,
  createFixtureSource,
  resolverFor,
} from './fixtures/artifact-fixture';

afterEach(async () => {
  await yieldToPortableEventLoop();
});

const INSTRUCTIONS = 'You are the implementer.';

async function createRanSession() {
  // Pinned to the fixture's clock so the artifact stays inside its retention window.
  const runtime = createManualRuntimeServices({ origin: new Date(FIXTURE_NOW).toISOString() });
  const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
  const handle = createSessionHandle('session-fixture', {
    store,
    agentName: 'implementer',
    runOptions: createTestRunOptions(),
    runtime,
    resolveFreshAttemptSource: resolverFor(createFixtureSource()),
  });
  await handle.run('first').result();
  await yieldToPortableEventLoop();
  await handle.run('second').result();
  await yieldToPortableEventLoop();
  return handle;
}

describe('applyConversationPolicy', () => {
  it('continues the same session when no policy is given', async () => {
    const handle = await createRanSession();
    const fork = spyOn(handle, 'fork');
    const fresh = spyOn(handle, 'startFreshAttempt');

    const target = await applyConversationPolicy(handle, { instructions: INSTRUCTIONS });

    expect(target).toBe(handle);
    expect(fork).not.toHaveBeenCalled();
    expect(fresh).not.toHaveBeenCalled();
  });

  it('continues the same session for an explicit continue policy', async () => {
    const handle = await createRanSession();

    const target = await applyConversationPolicy(handle, {
      policy: { kind: 'continue' },
      instructions: INSTRUCTIONS,
    });

    expect(target).toBe(handle);
  });

  it('binds fork-from-baseline to SessionHandle.fork(), copying the full history', async () => {
    const handle = await createRanSession();

    const target = await applyConversationPolicy(handle, {
      policy: { kind: 'fork-from-baseline' },
      instructions: INSTRUCTIONS,
    });

    expect(target.id).not.toBe(handle.id);
    const [source, forked] = await Promise.all([handle.getSession(), target.getSession()]);
    expect(forked.conversationHistory).toEqual(source.conversationHistory);
    expect(forked.runs).toEqual([]);
  });

  it('passes throughRun to fork(), which copies that run boundary or rejects a bad fork point', async () => {
    const handle = await createRanSession();
    const userTurns = (session: Awaited<ReturnType<SessionHandle['getSession']>>) =>
      session.conversationHistory.ids
        .map((id) => session.conversationHistory.messages[id])
        .filter((message) => message?.role === 'user')
        .map((message) => message?.content);

    const throughFirst = await applyConversationPolicy(handle, {
      policy: { kind: 'fork-from-baseline', throughRun: 0 },
      instructions: INSTRUCTIONS,
    });
    const [source, forked] = await Promise.all([handle.getSession(), throughFirst.getSession()]);
    expect(throughFirst.id).not.toBe(handle.id);
    expect(userTurns(source)).toEqual(['first', 'second']);
    expect(userTurns(forked)).toEqual(['first']);

    const rejection = await applyConversationPolicy(handle, {
      policy: { kind: 'fork-from-baseline', throughRun: 2 },
      instructions: INSTRUCTIONS,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(ForkThroughRunError);
    expect((rejection as ForkThroughRunError).reason).toBe('out-of-range');
  });

  it('binds fresh-from-artifact to SessionHandle.startFreshAttempt()', async () => {
    const handle = await createRanSession();
    const artifact = await createFixtureArtifact();

    const target = await applyConversationPolicy(handle, {
      policy: { kind: 'fresh-from-artifact', artifact },
      instructions: INSTRUCTIONS,
    });

    const [source, fresh] = await Promise.all([handle.getSession(), target.getSession()]);
    expect(target.id).not.toBe(handle.id);
    expect(fresh.runs).toEqual([]);
    const sourceIds = new Set(source.conversationHistory.ids);
    expect(fresh.conversationHistory.ids.some((id) => sourceIds.has(id))).toBe(false);
    expect(
      fresh.conversationHistory.messages[fresh.conversationHistory.ids[0] ?? '']?.content,
    ).toBe(INSTRUCTIONS);
  });
});
