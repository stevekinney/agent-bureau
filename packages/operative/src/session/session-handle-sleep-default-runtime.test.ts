import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import type { Toolbox } from 'armorer';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { GenerateFunction } from '../types';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';

/**
 * AB-330: split out of `session-handle.test.ts` — these two tests
 * deliberately verify `handle.sleep()`'s DEFAULT runtime argument (no
 * injected `RuntimeServices`): that it resolves after real elapsed
 * milliseconds have actually passed, measured against the real clock.
 * Injecting a manual runtime here would defeat the point of the test — same
 * reasoning armorer's `execution-lifecycle-default-runtime.test.ts` and
 * `with-idempotency-default-runtime.test.ts` use for AB-254.
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

  return {
    sessionId,
    store,
    handle: createSessionHandle(sessionId, {
      store,
      agentName: 'test-agent',
      runOptions: createTestRunOptions(),
    }),
  };
}

describe('createSessionHandle — sleep() default (real) runtime', () => {
  it('resolves after the specified milliseconds (in-memory path)', async () => {
    const { handle } = createSessionHandleFixture();
    const start = Date.now();
    await handle.sleep(10);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(9);
  });

  it('parses ISO-8601 PT duration strings', async () => {
    const { handle } = createSessionHandleFixture();
    const start = Date.now();
    await handle.sleep('PT0.01S'); // 10ms
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(9);
  });
});
