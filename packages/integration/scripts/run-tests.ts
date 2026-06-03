async function run(command: string[], environment: NodeJS.ProcessEnv = process.env) {
  const childProcess = Bun.spawn({
    cmd: command,
    cwd: import.meta.dir.replace(/\/scripts$/, ''),
    env: environment,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await childProcess.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

// Resolve a REAL Node.js binary for the cross-runtime test. The previous
// implementation spawned `/bin/zsh -lc 'command -v node'`, which fails with
// ENOENT on CI runners (ubuntu-latest has /bin/sh and /bin/bash, but no
// /bin/zsh). `Bun.which('node')` searches PATH with no shell — but on a
// Bun-only PATH it can resolve to a `node` that is actually Bun, and Bun cannot
// run `runtime.test.mjs` (it uses `node:test`, which errors with "Cannot use
// describe outside of the test runner" under Bun). So VERIFY the resolved binary
// is genuinely Node (its `--version` prints `vX.Y.Z`; Bun prints `1.3.13` with
// no `v`). If it isn't real Node, fail LOUDLY with the resolved path + version
// rather than letting the downstream `node:test` error obscure the cause.
/** Is `candidate` a REAL Node.js binary (its `--version` prints `vX.Y.Z`)? */
function isRealNode(candidate: string): boolean {
  const probe = Bun.spawnSync({ cmd: [candidate, '--version'], stdout: 'pipe', stderr: 'pipe' });
  const version = new TextDecoder().decode(probe.stdout).trim();
  return /^v\d+\.\d+\.\d+/.test(version);
}

function resolveNodeBinary(): string {
  // When a script runs under `bun run`, Bun injects its OWN node-compatible shim
  // (e.g. /tmp/bun-node-XXXX/node) at the FRONT of PATH. That shim is not real
  // Node — its `--version` is empty and it cannot run `node:test` — so a plain
  // `Bun.which('node')` resolves to it and shadows the real Node that CI's
  // actions/setup-node installed. Strip Bun's injected shim dir from PATH and
  // resolve against the remainder so we find the genuine Node binary.
  const cleanedPath = (process.env['PATH'] ?? '')
    .split(':')
    .filter((entry) => !entry.includes('bun-node') && !entry.endsWith('/.bun/bin'))
    .join(':');

  const candidate = Bun.which('node', { PATH: cleanedPath });
  if (!candidate || !isRealNode(candidate)) {
    throw new Error(
      `Unable to locate a real Node.js binary for the runtime cross-runtime test ` +
        `(resolved "${candidate ?? 'nothing'}" on the Bun-stripped PATH). CI must ` +
        'install Node (actions/setup-node) — Bun cannot run node:test files.',
    );
  }

  return candidate;
}

const nodeBinary = resolveNodeBinary();

await run(['bun', 'test', 'test/import-boundary.test.ts']);
await run(['bun', 'test', 'test/operative.test.ts']);
await run(['bun', 'test', 'test/sentinel.test.ts']);
const nodeEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && key !== 'NODE_OPTIONS' && !key.startsWith('BUN'),
  ),
);

await run([nodeBinary, '--test', 'test/runtime.test.mjs'], nodeEnvironment);
