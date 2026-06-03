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
function resolveNodeBinary(): string {
  const candidate = Bun.which('node');
  if (!candidate) {
    throw new Error(
      'Unable to locate a Node.js binary for the runtime cross-runtime test. ' +
        'CI must install Node (e.g. actions/setup-node) — Bun cannot run node:test files.',
    );
  }

  const versionProbe = Bun.spawnSync({ cmd: [candidate, '--version'], stdout: 'pipe', stderr: 'pipe' });
  const version = new TextDecoder().decode(versionProbe.stdout).trim();
  if (!/^v\d+\.\d+\.\d+/.test(version)) {
    throw new Error(
      `Resolved "node" at ${candidate} is not a real Node.js binary ` +
        `(\`--version\` reported "${version}" — Node prints "vX.Y.Z"). ` +
        'This is usually a Bun-only PATH shadowing real Node; CI must install Node ' +
        'so the runtime cross-runtime test (node:test) can run.',
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
