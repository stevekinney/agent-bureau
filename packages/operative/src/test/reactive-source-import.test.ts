import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('the public operative entry imports in a plain Bun process without the test runner', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      "const api = await import('@lostgradient/operative'); if (typeof api.runReactiveSourceConformanceSuite !== 'function') throw new Error('Missing conformance API');",
    ],
    { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' },
  );
  const [status, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(status, errors).toBe(0);
  expect(errors).toBe('');
});

test('the conformance suite bundles for a browser without any runtime test framework', async () => {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, 'reactive-source-suite.ts')],
    target: 'browser',
  });
  expect(result.success, result.logs.map(String).join('\n')).toBe(true);
  expect(result.logs).toHaveLength(0);
  const artifact = result.outputs.find((output) => output.kind === 'entry-point');
  if (!artifact) throw new Error('Missing browser entry');
  const contents = await artifact.text();
  expect(contents).not.toContain('bun:test');
  expect(contents).not.toContain('Bun.');
});
