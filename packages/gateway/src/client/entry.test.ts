import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SveltePlugin } from 'bun-plugin-svelte';

const entryPath = `${import.meta.dir}/entry.ts`;

let stylesheet = '';

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [entryPath],
    target: 'browser',
    format: 'esm',
    splitting: true,
    plugins: [SveltePlugin()],
  });

  expect(result.success).toBe(true);
  const cssOutputs = await Promise.all(
    result.outputs
      .filter((output) => output.path.endsWith('.css'))
      .map(async (output) => {
        const text = await output.text();
        return text;
      }),
  );
  stylesheet = cssOutputs.join('\n');
});

afterAll(() => {
  stylesheet = '';
});

describe('Gateway client styles', () => {
  it('includes styles imported by Cinder component entrypoints', () => {
    expect(stylesheet).toContain('.cinder-card');
    expect(stylesheet).toContain('.cinder-textarea');
  });

  it('does not maintain a separate Cinder component stylesheet list', async () => {
    const entry = await Bun.file(entryPath).text();

    expect(entry).not.toMatch(/@lostgradient\/cinder\/.+\/styles/);
  });
});
