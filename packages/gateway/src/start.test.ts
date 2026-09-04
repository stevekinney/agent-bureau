import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { describe, expect, it, spyOn } from 'bun:test';

import {
  apiKeyFor,
  main,
  parseStartEnvironment,
  resolveStartOptions,
  shutdownGateway,
  type StartEnvironment,
  startGateway,
} from './start';
import type { GatewayShutdownReport } from './types';

const BASE_ENVIRONMENT: Record<string, string | undefined> = {};

// Unique per-invocation temp database paths for the real bun:sqlite-backed
// boot tests below, without a real clock/random read (AB-333): `process.pid`
// already separates concurrent test processes, and this plain in-process
// counter separates the several such paths minted within one process.
let temporaryPathCounter = 0;
function nextTemporaryPathSuffix(): string {
  return `${process.pid}-${temporaryPathCounter++}`;
}

describe('parseStartEnvironment', () => {
  it('defaults STORAGE_TYPE to sqlite and PROVIDER to anthropic', () => {
    const environment = parseStartEnvironment(BASE_ENVIRONMENT);
    expect(environment.STORAGE_TYPE).toBe('sqlite');
    expect(environment.PROVIDER).toBe('anthropic');
  });

  it('coerces PORT to a number', () => {
    const environment = parseStartEnvironment({ PORT: '4321' });
    expect(environment.PORT).toBe(4321);
  });

  it('rejects an unknown STORAGE_TYPE', () => {
    let caught: unknown;
    try {
      parseStartEnvironment({ STORAGE_TYPE: 'postgres' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('Invalid gateway environment configuration');
  });

  it('rejects a negative PORT', () => {
    let caught: unknown;
    try {
      parseStartEnvironment({ PORT: '-1' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it('accepts PORT=0 (ephemeral port)', () => {
    const environment = parseStartEnvironment({ PORT: '0' });
    expect(environment.PORT).toBe(0);
  });

  it('treats a blank AUTH_TOKEN the same as unset', () => {
    const environment = parseStartEnvironment({ AUTH_TOKEN: '' });
    expect(environment.AUTH_TOKEN).toBeUndefined();
  });

  it('treats a blank provider API key the same as unset', () => {
    const environment = parseStartEnvironment({
      PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: '   ',
    });
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('resolveStartOptions', () => {
  it('defaults to sqlite storage at the documented default path', () => {
    const options = resolveStartOptions(parseStartEnvironment(BASE_ENVIRONMENT));
    expect(options.bureau.storage).toEqual({
      type: 'sqlite',
      path: './data/agent-bureau.sqlite',
    });
  });

  it('honors an explicit STORAGE_PATH', () => {
    const options = resolveStartOptions(
      parseStartEnvironment({ STORAGE_TYPE: 'sqlite', STORAGE_PATH: './custom.db' }),
    );
    expect(options.bureau.storage).toEqual({ type: 'sqlite', path: './custom.db' });
  });

  it('builds lmdb storage with the documented default path', () => {
    const options = resolveStartOptions(parseStartEnvironment({ STORAGE_TYPE: 'lmdb' }));
    expect(options.bureau.storage).toEqual({
      type: 'lmdb',
      path: './data/agent-bureau-lmdb',
    });
  });

  it('builds memory storage with no path', () => {
    const options = resolveStartOptions(parseStartEnvironment({ STORAGE_TYPE: 'memory' }));
    expect(options.bureau.storage).toEqual({ type: 'memory' });
  });

  it('omits provider config when no API key is set for PROVIDER', () => {
    const options = resolveStartOptions(
      parseStartEnvironment({ PROVIDER: 'anthropic', OPENAI_API_KEY: 'sk-openai' }),
    );
    expect(options.bureau.provider).toBeUndefined();
  });

  it('configures the provider when its API key is present', () => {
    const options = resolveStartOptions(
      parseStartEnvironment({ PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' }),
    );
    expect(options.bureau.provider).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-5',
      apiKey: 'sk-ant',
    });
  });

  it('honors an explicit MODEL override', () => {
    const options = resolveStartOptions(
      parseStartEnvironment({
        PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-openai',
        MODEL: 'gpt-5.4-mini',
      }),
    );
    expect(options.bureau.provider).toEqual({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      apiKey: 'sk-openai',
    });
  });

  it('passes through door-only gateway options', () => {
    const options = resolveStartOptions(
      parseStartEnvironment({ PORT: '9001', GATEWAY_HOST: '0.0.0.0', AUTH_TOKEN: 'secret' }),
    );
    expect(options.gateway).toEqual({ port: 9001, hostname: '0.0.0.0', authToken: 'secret' });
  });

  it('leaves gateway options empty when unset', () => {
    const options = resolveStartOptions(parseStartEnvironment(BASE_ENVIRONMENT));
    expect(options.gateway).toEqual({});
  });

  it('wires EVALUATION_REPORTS_DIRECTORY into GatewayOptions.evaluationReportsDirectory', () => {
    const options = resolveStartOptions(
      parseStartEnvironment({ EVALUATION_REPORTS_DIRECTORY: './reports' }),
    );
    expect(options.gateway.evaluationReportsDirectory).toBe('./reports');
  });

  it('leaves evaluationReportsDirectory unset when EVALUATION_REPORTS_DIRECTORY is unset', () => {
    const options = resolveStartOptions(parseStartEnvironment(BASE_ENVIRONMENT));
    expect(options.gateway.evaluationReportsDirectory).toBeUndefined();
  });
});

describe('startGateway', () => {
  it('boots a listening gateway from parsed environment (ready=false without an API key)', async () => {
    const databasePath = join(tmpdir(), `gateway-start-${nextTemporaryPathSuffix()}.sqlite`);
    const environment: StartEnvironment = parseStartEnvironment({
      STORAGE_TYPE: 'sqlite',
      STORAGE_PATH: databasePath,
      // Port 0 (ephemeral): the assertions below go through the Hono app
      // directly (matching this package's existing test convention) rather
      // than a real network fetch against `gateway.port`, so an
      // OS-assigned port avoids collisions on shared/CI machines without
      // needing the actual bound port for anything.
      PORT: '0',
      AUTH_TOKEN: 'test-token',
    });

    try {
      // start() still proves the full wire-up (bureau -> gateway ->
      // Bun.serve) succeeds end to end even though the assertions below
      // don't touch the real socket.
      const { gateway, server } = await startGateway(environment);
      try {
        expect(gateway.bureau.ready).toBe(false);

        const response = await gateway.app.request('/api/v1/health/live', {
          headers: { authorization: 'Bearer test-token' },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: 'ok' });

        const readyResponse = await gateway.app.request('/api/v1/health/ready', {
          headers: { authorization: 'Bearer test-token' },
        });
        expect(readyResponse.status).toBe(503);
      } finally {
        await server.stop();
        gateway.bureau.dispose();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });

  it('creates a not-yet-existing parent directory for a file-backed storage path', async () => {
    // bun:sqlite creates the database FILE but not its parent directory —
    // opening a path under a directory that doesn't exist yet fails with
    // SQLITE_CANTOPEN. This is exactly the shape of the documented default
    // (`./data/agent-bureau.sqlite`) on a machine where `./data` has never
    // been created.
    const rootDirectory = join(tmpdir(), `gateway-start-mkdir-${nextTemporaryPathSuffix()}`);
    const databasePath = join(rootDirectory, 'nested', 'agent-bureau.sqlite');
    const environment: StartEnvironment = parseStartEnvironment({
      STORAGE_TYPE: 'sqlite',
      STORAGE_PATH: databasePath,
      PORT: '0',
    });

    try {
      const { gateway, server } = await startGateway(environment);
      await server.stop();
      gateway.bureau.dispose();
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});

describe('shutdownGateway', () => {
  function createFakeReportingServer(report: GatewayShutdownReport) {
    return { stop: async () => report };
  }

  function createFakeBureau() {
    let disposeCalled = false;
    return {
      bureau: {
        dispose: async () => {
          disposeCalled = true;
        },
      },
      wasDisposeCalled: () => disposeCalled,
    };
  }

  function createFakeLogger() {
    const lines: string[] = [];
    return { log: (message: string) => lines.push(message), lines };
  }

  it('logs a clean-drain message and disposes the bureau on a clean shutdown', async () => {
    const server = createFakeReportingServer({ drained: true, forcedConnections: 0 });
    const { bureau, wasDisposeCalled } = createFakeBureau();
    const logger = createFakeLogger();

    const report = await shutdownGateway({ bureau }, server, logger);

    expect(report).toEqual({ drained: true, forcedConnections: 0 });
    expect(wasDisposeCalled()).toBe(true);
    expect(logger.lines).toContain('[gateway] drained cleanly');
  });

  it('logs the forced-connection count and still disposes the bureau after a timed-out drain', async () => {
    const server = createFakeReportingServer({ drained: false, forcedConnections: 2 });
    const { bureau, wasDisposeCalled } = createFakeBureau();
    const logger = createFakeLogger();

    const report = await shutdownGateway({ bureau }, server, logger);

    expect(report).toEqual({ drained: false, forcedConnections: 2 });
    expect(wasDisposeCalled()).toBe(true);
    expect(logger.lines).toContain(
      '[gateway] drain timed out — force-closed 2 live-stream connection(s)',
    );
  });

  it('still disposes the bureau when server.stop() rejects', async () => {
    const failure = new Error('stop failed');
    const server = { stop: async () => Promise.reject(failure) };
    const { bureau, wasDisposeCalled } = createFakeBureau();
    const logger = createFakeLogger();

    let caught: unknown;
    try {
      await shutdownGateway({ bureau }, server, logger);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(wasDisposeCalled()).toBe(true);
  });
});

describe('apiKeyFor', () => {
  it('reads GEMINI_API_KEY when PROVIDER is gemini', () => {
    const environment = parseStartEnvironment({ PROVIDER: 'gemini', GEMINI_API_KEY: 'gk' });
    expect(apiKeyFor(environment)).toBe('gk');
  });
});

describe('main', () => {
  /** Snapshots and restores every env var `main()`/`parseStartEnvironment` reads. */
  const ENV_KEYS = [
    'PORT',
    'GATEWAY_HOST',
    'AUTH_TOKEN',
    'STORAGE_TYPE',
    'STORAGE_PATH',
    'EVALUATION_REPORTS_DIRECTORY',
    'PROVIDER',
    'MODEL',
    'SYSTEM_PROMPT',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
  ] as const;

  /**
   * Sets `Bun.env[key] = value` for a defined `value`, or deletes the key
   * entirely for `undefined` — never `Bun.env[key] = undefined`, which
   * environment objects coerce to the literal string `"undefined"` instead
   * of leaving the key absent (AB-316, copilot review on #522: the same bug
   * this helper's own restore step below already guards against applies
   * equally to applying `overrides`, since its type — `Record<string,
   * string | undefined>` — allows a caller to explicitly override a key to
   * unset).
   */
  function applyEnv(target: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(target)) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }

  function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>) {
    const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, Bun.env[key]]));
    for (const key of ENV_KEYS) delete Bun.env[key];
    applyEnv(overrides);
    return run().finally(() => {
      // AB-316: restore by DELETING a key that was originally unset, never
      // by `Object.assign`-ing an `undefined` value back in — see
      // `applyEnv`'s own comment above. See the regression test below.
      for (const key of ENV_KEYS) delete Bun.env[key];
      applyEnv(snapshot);
    });
  }

  it('withEnv restores an originally-unset key to fully absent, never the literal string "undefined" (AB-316 regression)', async () => {
    delete Bun.env['PROVIDER'];
    await withEnv({ PROVIDER: 'gemini' }, async () => {
      expect(Bun.env['PROVIDER']).toBe('gemini');
    });
    expect(Bun.env['PROVIDER']).toBeUndefined();
    expect('PROVIDER' in Bun.env).toBe(false);
  });

  it('withEnv leaves a key fully absent when an override explicitly sets it to undefined, never the literal string "undefined" (AB-316 regression, copilot review on #522)', async () => {
    Bun.env['PROVIDER'] = 'openai';
    await withEnv({ PROVIDER: undefined }, async () => {
      expect(Bun.env['PROVIDER']).toBeUndefined();
      expect('PROVIDER' in Bun.env).toBe(false);
    });
    expect(Bun.env['PROVIDER']).toBe('openai');
  });

  it('boots the gateway, warns for memory storage and a missing API key, and registers shutdown handlers', async () => {
    const databasePath = join(tmpdir(), `gateway-main-${nextTemporaryPathSuffix()}.sqlite`);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);

    try {
      const booted = await withEnv(
        { STORAGE_TYPE: 'memory', PORT: '0', PROVIDER: 'anthropic' },
        () => main(),
      );
      try {
        expect(booted.gateway.bureau.ready).toBe(false);
        expect(warnings.some((args) => String(args[0]).includes('STORAGE_TYPE=memory'))).toBe(true);
        expect(warnings.some((args) => String(args[0]).includes('No API key found'))).toBe(true);
      } finally {
        await shutdownGateway(booted.gateway, booted.server);
      }
    } finally {
      console.warn = originalWarn;
      await rm(databasePath, { force: true });
    }
  });

  it('boots without warning when a provider API key is configured', async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);

    try {
      const booted = await withEnv(
        { STORAGE_TYPE: 'memory', PORT: '0', PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'key' },
        () => main(),
      );
      try {
        expect(booted.gateway.bureau.ready).toBe(true);
        expect(warnings.some((args) => String(args[0]).includes('No API key found'))).toBe(false);
      } finally {
        await shutdownGateway(booted.gateway, booted.server);
      }
    } finally {
      console.warn = originalWarn;
    }
  });

  it("returns handleShutdownSignal, the exact function registered as process.on's SIGTERM/SIGINT listener, and calling it drains, disposes, and exits exactly once", async () => {
    const booted = await withEnv(
      { STORAGE_TYPE: 'memory', PORT: '0', PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'key' },
      () => main(),
    );

    const exitCalls: number[] = [];
    const exitSpy = spyOn(process, 'exit').mockImplementation((code?: number) => {
      exitCalls.push(code ?? 0);
      return undefined as never;
    });
    const logs: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args);

    try {
      // Calling `handleShutdownSignal` directly is the same function object
      // `main()` passed to `process.on` — no real signal, no shared-process
      // side effects. It fires the async `shutdown` and returns void, so
      // poll (bounded) for the process.exit call it drives.
      booted.handleShutdownSignal('SIGTERM');
      for (let attempt = 0; attempt < 50 && exitCalls.length === 0; attempt += 1) {
        await yieldToPortableEventLoop();
      }
      expect(logs.some((args) => String(args[0]).includes('received SIGTERM'))).toBe(true);
      expect(exitCalls).toEqual([0]);

      // The debounce guard: a second call (even for a different signal, and
      // even through the async `shutdown` this time) after `shuttingDown` is
      // already true must be a genuine no-op — no second drain log, no
      // second process.exit call.
      await booted.shutdown('SIGINT');
      expect(logs.filter((args) => String(args[0]).includes('received')).length).toBe(1);
      expect(exitCalls).toEqual([0]);
    } finally {
      console.log = originalLog;
      exitSpy.mockRestore();
    }
  });
});
