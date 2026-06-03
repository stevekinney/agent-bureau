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

// Resolve the `node` binary portably. The previous implementation spawned
// `/bin/zsh -lc 'command -v node'`, which fails with ENOENT on CI runners
// (ubuntu-latest has /bin/sh and /bin/bash, but no /bin/zsh). `Bun.which`
// searches PATH directly with no shell, so it works on the dev's macOS and on
// CI alike.
const nodeBinary = Bun.which('node');
if (!nodeBinary) {
  throw new Error('Unable to locate the Node.js binary for runtime integration tests.');
}

await run(['bun', 'test', 'test/import-boundary.test.ts']);
await run(['bun', 'test', 'test/operative.test.ts']);
await run(['bun', 'test', 'test/sentinel.test.ts']);
const nodeEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && key !== 'NODE_OPTIONS' && !key.startsWith('BUN'),
  ),
);

await run([nodeBinary, '--test', 'test/runtime.test.mjs'], nodeEnvironment);
