const packageDirectory = import.meta.dir.replace(/\/scripts$/, '');

async function run(command: string[], environment: NodeJS.ProcessEnv = process.env) {
  const childProcess = Bun.spawn({
    cmd: command,
    cwd: packageDirectory,
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

function resolveNodeBinary(): string | null {
  const homeDirectory = process.env['HOME'];
  const pathCandidates = (process.env['PATH'] ?? '')
    .split(':')
    .filter(Boolean)
    .map((directory) => `${directory}/node`);

  const candidates = new Set(
    [
      process.env['NODE_BINARY'],
      process.env['NODE'],
      typeof Bun.which === 'function' ? Bun.which('node') : undefined,
      'node',
      ...pathCandidates,
      homeDirectory ? `${homeDirectory}/.asdf/shims/node` : undefined,
      homeDirectory ? `${homeDirectory}/.volta/bin/node` : undefined,
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
    ].filter((candidate): candidate is string => Boolean(candidate)),
  );

  for (const candidate of candidates) {
    let result: Bun.SyncSubprocess<Buffer, Buffer>;
    try {
      result = Bun.spawnSync({
        cmd: [candidate, '--version'],
        cwd: packageDirectory,
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch {
      continue;
    }

    if (result.exitCode === 0) {
      return candidate;
    }
  }

  return null;
}

const nodeBinary = resolveNodeBinary();
if (!nodeBinary) {
  throw new Error('Unable to locate the Node.js binary for runtime integration tests.');
}

await run(['bun', 'test', 'test/import-boundary.test.ts']);
await run(['bun', 'test', 'test/operative.test.ts']);
await run(['bun', 'test', 'test/operative-store.test.ts']);
const nodeEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && key !== 'NODE_OPTIONS' && !key.startsWith('BUN'),
  ),
);

await run([nodeBinary, '--test', 'test/runtime.test.mjs'], nodeEnvironment);
