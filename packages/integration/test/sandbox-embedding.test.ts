/**
 * AB-97 — Sandbox-image embedding: bundling, isolation, footprint proof.
 *
 * `sandbox-runner.ts` is a minimal runner — `armorer`'s read-only coding
 * toolbox + `operative`'s agent loop + the Anthropic provider — with no
 * dependency on `gateway` or `bureau`. This file bundles it with
 * `bun build --target=bun` into ONE outfile, spawns that outfile as a real
 * child process, and drives it against a local `Bun.serve` mock standing in
 * for the Anthropic Messages API. Three things are under test:
 *
 * 1. Bundling: the Anthropic provider's `import('@anthropic-ai/sdk')`
 *    (a lazy, zero-SDK-if-unused dynamic import — see
 *    `packages/operative/src/providers/anthropic.ts`) must survive being
 *    bundled into a single file and still resolve at runtime with no
 *    `node_modules` on disk next to the outfile. If it didn't, the fallback
 *    documented in `documentation/deployment.md`'s embedding recipe is to
 *    inject a statically-imported `Anthropic` client via `options.client`
 *    instead of relying on the dynamic import.
 * 2. Filesystem isolation: the bundled runner touches nothing outside its
 *    declared coding-tool root and its own outfile. Proven by pointing
 *    `HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_DATA_HOME` at an empty
 *    temp directory and asserting it is still empty after the run, while a
 *    real read *inside* the declared root does succeed.
 * 3. Network isolation: the mock server sees only the expected
 *    `POST /v1/messages` calls, at the configured `baseURL`, and nothing
 *    else — there is no second listener for the runner to have reached.
 *
 * Honesty about what this proves: this is a behavioral smoke test for the
 * given inputs, run under the test process's own OS user and permissions —
 * it is not a syscall-level sandbox (no seccomp/landlock/network-namespace
 * enforcement) and cannot prove the runner *could not* reach the filesystem
 * or network under a different code path. It proves this bundled artifact,
 * run with this conversation, did not.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const FIXTURE_ENTRY = join(import.meta.dir, 'fixtures', 'sandbox-runner.ts');

interface RecordedRequest {
  method: string;
  path: string;
}

interface RecordingServer {
  baseURL: string;
  requests: RecordedRequest[];
  stop: () => void;
}

/**
 * Stands in for the Anthropic Messages API: first call returns a
 * `read-file` tool call, second call returns a final text response — the
 * runner's `stopWhen.noToolCalls()` loop ends there.
 */
function createMockAnthropicServer(): RecordingServer {
  const requests: RecordedRequest[] = [];
  let callCount = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      callCount += 1;
      const body =
        callCount === 1
          ? {
              id: 'msg_ab97_1',
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_ab97_1',
                  name: 'read-file',
                  input: { path: 'manifest.txt' },
                },
              ],
              model: 'claude-3-5-sonnet-20241022',
              stop_reason: 'tool_use',
              usage: { input_tokens: 12, output_tokens: 8 },
            }
          : {
              id: 'msg_ab97_2',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'The manifest says: sandbox-embedding-fixture.' }],
              model: 'claude-3-5-sonnet-20241022',
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 6 },
            };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return {
    baseURL: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(),
  };
}

describe('AB-97 sandbox-image embedding', () => {
  it(
    'bundles operative + armorer/coding + the Anthropic provider into one file that ' +
      'executes against a mock endpoint, touches only its declared root, and reaches ' +
      'only the configured baseURL',
    async () => {
      const bundleDirectory = await mkdtemp(join(tmpdir(), 'ab97-bundle-'));
      const declaredRoot = await mkdtemp(join(tmpdir(), 'ab97-root-'));
      const emptyHome = await mkdtemp(join(tmpdir(), 'ab97-home-'));
      const outfile = join(bundleDirectory, 'sandbox-runner.js');

      await writeFile(join(declaredRoot, 'manifest.txt'), 'sandbox-embedding-fixture\n');

      // --- 1. Bundle: single outfile, `bun build --target=bun` ---------
      const buildStartedAt = performance.now();
      const build = await Bun.build({
        entrypoints: [FIXTURE_ENTRY],
        target: 'bun',
        outdir: bundleDirectory,
        naming: 'sandbox-runner.js',
        // Explicit, not relying on Bun's current defaults: single-outfile
        // intent must stay stable even if a future Bun version starts
        // splitting chunks or emitting sourcemaps by default.
        splitting: false,
        sourcemap: 'none',
      });
      const buildDurationMs = performance.now() - buildStartedAt;
      expect(build.success).toBe(true);

      const bundleDirectoryEntries = await readdir(bundleDirectory);
      // Exactly one artifact: proves this is a genuine single-outfile
      // bundle, not a build that silently split into multiple chunks.
      expect(bundleDirectoryEntries).toEqual(['sandbox-runner.js']);

      const bundleStat = await Bun.file(outfile).stat();
      expect(bundleStat.size).toBeGreaterThan(0);

      // --- 2. Execute: spawn the bundled outfile as a real child process
      const mock = createMockAnthropicServer();
      try {
        const homeEntriesBeforeRun = await readdir(emptyHome);
        expect(homeEntriesBeforeRun).toEqual([]);

        const coldStartStartedAt = performance.now();
        const child = Bun.spawn({
          cmd: [process.execPath, 'run', outfile],
          cwd: bundleDirectory,
          env: {
            // A deliberately minimal, isolated environment: the runner's
            // own declared root/config, no ambient PATH-discovered tools
            // (empty PATH — the runner's read-only tool surface never
            // shells out), no inherited credentials.
            PATH: '',
            SANDBOX_RUNNER_ROOT: declaredRoot,
            SANDBOX_RUNNER_BASE_URL: mock.baseURL,
            SANDBOX_RUNNER_API_KEY: 'placeholder-not-a-real-key-0000',
            HOME: emptyHome,
            XDG_CONFIG_HOME: emptyHome,
            XDG_CACHE_HOME: emptyHome,
            XDG_DATA_HOME: emptyHome,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        const coldStartDurationMs = performance.now() - coldStartStartedAt;

        expect(exitCode).toBe(0);

        const lastLine = stdout.trim().split('\n').at(-1) ?? '';
        const parsed = JSON.parse(lastLine) as { content: string; toolCallCount: number };
        expect(parsed.toolCallCount).toBe(1);
        expect(parsed.content).toBe('The manifest says: sandbox-embedding-fixture.');
        expect(stderr).toBe('');

        // --- 3. Network isolation: only the expected calls landed -----
        const endpoints = new Set(mock.requests.map((request) => `${request.method} ${request.path}`));
        expect(endpoints).toEqual(new Set(['POST /v1/messages']));
        expect(mock.requests).toHaveLength(2);

        // --- 2 (cont'd). Filesystem isolation: HOME/XDG untouched ------
        const homeEntriesAfterRun = await readdir(emptyHome);
        expect(homeEntriesAfterRun).toEqual([]);

        // Footprint numbers (NOT enforced — recorded for
        // documentation/deployment.md's AB-97 slot; a sanity ceiling only,
        // not a regression gate).
        expect(bundleStat.size).toBeLessThan(50 * 1024 * 1024);
        console.log(
          `[AB-97] bundle size: ${bundleStat.size} bytes; build time: ` +
            `${buildDurationMs.toFixed(1)}ms; cold start (spawn → first stdout line): ` +
            `${coldStartDurationMs.toFixed(1)}ms`,
        );
      } finally {
        mock.stop();
      }

      await rm(bundleDirectory, { recursive: true, force: true });
      await rm(declaredRoot, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    },
    30_000,
  );
});
