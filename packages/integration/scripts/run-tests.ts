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

const resolvedNode = Bun.spawnSync({
  cmd: ['/bin/zsh', '-lc', 'command -v node'],
  cwd: import.meta.dir.replace(/\/scripts$/, ''),
  env: process.env,
  stdout: 'pipe',
  stderr: 'pipe',
});

const nodeBinary = new TextDecoder().decode(resolvedNode.stdout).trim();
if (!nodeBinary) {
  throw new Error('Unable to locate the Node.js binary for runtime integration tests.');
}

await run(['bun', 'test', 'test/import-boundary.test.ts']);
const nodeEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined && key !== 'NODE_OPTIONS' && !key.startsWith('BUN'),
  ),
);

await run([nodeBinary, '--test', 'test/runtime.test.mjs'], nodeEnvironment);
