import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  parseStartEnvironment,
  resolveStartOptions,
  type StartEnvironment,
  startGateway,
} from './start';

const BASE_ENVIRONMENT: Record<string, string | undefined> = {};

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

  it('rejects a non-positive PORT', () => {
    let caught: unknown;
    try {
      parseStartEnvironment({ PORT: '-1' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
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
      parseStartEnvironment({ PORT: '9001', HOSTNAME: '0.0.0.0', AUTH_TOKEN: 'secret' }),
    );
    expect(options.gateway).toEqual({ port: 9001, hostname: '0.0.0.0', authToken: 'secret' });
  });

  it('leaves gateway options empty when unset', () => {
    const options = resolveStartOptions(parseStartEnvironment(BASE_ENVIRONMENT));
    expect(options.gateway).toEqual({});
  });
});

describe('startGateway', () => {
  it('boots a listening gateway from parsed environment (ready=false without an API key)', async () => {
    const databasePath = join(tmpdir(), `gateway-start-${process.pid}-${Date.now()}.sqlite`);
    const environment: StartEnvironment = parseStartEnvironment({
      STORAGE_TYPE: 'sqlite',
      STORAGE_PATH: databasePath,
      // A fixed port, not 0: `Gateway.port` is the requested port captured
      // before `Bun.serve` binds, not the OS-assigned one, so an ephemeral
      // port here would make `gateway.port` wrong for the assertions below.
      PORT: '58734',
      AUTH_TOKEN: 'test-token',
    });

    try {
      // start() proves the full wire-up (bureau -> gateway -> Bun.serve)
      // succeeds end to end; the assertions below go through the Hono app
      // directly (matching this package's existing test convention) rather
      // than a real network fetch against gateway.port.
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
        server.stop();
        gateway.bureau.dispose();
      }
    } finally {
      await rm(databasePath, { force: true });
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
    }
  });
});
