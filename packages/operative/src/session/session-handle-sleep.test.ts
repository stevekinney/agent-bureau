import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import type { Toolbox } from 'armorer';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';

/**
 * AB-348: split out of `session-handle.test.ts` (originally AB-330). These
 * two tests verify `handle.sleep()`'s resolution timing. The original form
 * exercised `sleep()`'s DEFAULT runtime argument (no injected
 * `RuntimeServices`) against the real clock. `SessionHandleContext.runtime`
 * is an existing injectable seam (AB-92/AB-252/AB-253) — `sleep()` awaits
 * `processLocalDelay` through `setTimeoutFunction`/`clearTimeoutFunction`,
 * which resolve from `context.setTimeoutFunction ?? runtime.timers.setTimeout`
 * — so unlike the two genuinely real-runtime-only tests this issue could not
 * find a seam for, a seam already exists here and the coordinator ruling
 * requires injecting through it rather than keeping an absence-proof. These
 * tests now supply a manual runtime and drive its virtual clock explicitly:
 * `sleep()` stays pending before the requested duration elapses on the
 * manual clock and resolves the instant it does, with no real timer
 * involved.
 */

function createInstantGenerate(content = 'hello'): GenerateFunction {
  return async () => ({
    content,
    toolCalls: [],
  });
}

function createTestRunOptions(generate: GenerateFunction = createInstantGenerate()) {
  return {
    generate,
    toolbox: createToolbox([]) as unknown as Toolbox,
    maximumSteps: 1,
  };
}

function createSessionHandleFixture() {
  const sessionId = 'test-session';
  const kv = textValueStore(new MemoryStorage());
  const store = createSessionStore(kv);
  const runtime = createManualRuntimeServices();

  return {
    sessionId,
    store,
    runtime,
    handle: createSessionHandle(sessionId, {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(),
      runtime,
    }),
  };
}

describe('createSessionHandle — sleep() against an injected manual runtime', () => {
  it('resolves only after the manual clock advances past the requested milliseconds', async () => {
    const { handle, runtime } = createSessionHandleFixture();
    let resolved = false;
    const pending = handle.sleep(10).then(() => {
      resolved = true;
    });

    await runtime.advance(9);
    expect(resolved).toBe(false);

    await runtime.advance(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it('parses ISO-8601 PT duration strings against the manual clock', async () => {
    const { handle, runtime } = createSessionHandleFixture();
    let resolved = false;
    const pending = handle.sleep('PT0.01S').then(() => {
      resolved = true;
    }); // 10ms

    await runtime.advance(9);
    expect(resolved).toBe(false);

    await runtime.advance(1);
    await pending;
    expect(resolved).toBe(true);
  });
});
