/**
 * Verifies the published Armorer contract from an npm tarball in isolated consumers.
 *
 * Usage: `bun run scripts/verify-armorer-consumer.ts --mode local`
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { $ } from 'bun';

const root = join(import.meta.dir, '..');
const packageDirectory = join(root, 'packages', 'armorer');
const browserSubpaths = [
  '.',
  './core',
  './query',
  './inspect',
  './adapters/openai',
  './adapters/anthropic',
  './adapters/gemini',
  './utilities',
  './lazy',
  './registry',
  './tools',
  './instrumentation',
  './middleware',
  './test',
  './truncation',
  './idempotency',
  './openapi',
];
const serverOnlySubpaths = ['./mcp', './coding', './adapters/open-ai/agents'];
const svelteKitVersions = {
  adapterAuto: '7.0.1',
  kit: '2.70.3',
  viteSveltePlugin: '7.3.0',
  svelte: '5.56.9',
  vite: '8.2.1',
};
const inheritedPath = process.env.PATH;
const realNodePath = inheritedPath
  ?.split(delimiter)
  .filter((segment) => !segment.includes('bun-node-'))
  .join(delimiter);
const nodeBinary = (await Bun.file('/opt/homebrew/bin/node').exists())
  ? '/opt/homebrew/bin/node'
  : Bun.which('node', realNodePath ? { PATH: realNodePath } : undefined);
if (!nodeBinary) throw new Error('Could not locate genuine Node.js on PATH');

async function run(command: string[], cwd: string): Promise<string> {
  const [executable, ...arguments_] = command;
  const result = await $`${executable} ${arguments_}`.cwd(cwd).nothrow().quiet();
  const output = `${result.stdout}${result.stderr}`;
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed:\n${output}`);
  return output;
}

async function pack(staging: string): Promise<string> {
  const output = await run(
    ['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', staging],
    packageDirectory,
  );
  const filename = (JSON.parse(output) as Array<{ filename: string }>)[0]?.filename;
  if (!filename) throw new Error('npm pack produced no tarball');
  return join(staging, filename);
}

async function installConsumer(
  directory: string,
  tarball: string,
  dependencies: Record<string, string> = {},
): Promise<void> {
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        name: 'armorer-consumer',
        private: true,
        type: 'module',
        dependencies: { armorer: `file:${tarball}`, zod: '4.4.3', ...dependencies },
      },
      null,
      2,
    ),
  );
  await run(['npm', 'install', '--no-audit', '--no-fund'], directory);
}

async function verifyTypeSurface(directory: string, tarball: string): Promise<void> {
  await installConsumer(directory, tarball, {
    typescript: '6.0.3',
    '@opentelemetry/api': '1.9.1',
  });
  await Bun.write(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: false,
        module: 'Preserve',
        moduleResolution: 'bundler',
        target: 'ESNext',
        noEmit: true,
      },
      include: ['index.ts'],
    }),
  );
  await Bun.write(
    join(directory, 'index.ts'),
    `
import { createTool, createToolbox } from 'armorer';
import { toOpenAITools } from 'armorer/adapters/openai';
import { pipe } from 'armorer/utilities';
import { truncateText } from 'armorer/truncation';
createToolbox(); createTool({ name: 'x', description: 'x', execute: async () => 1 });
toOpenAITools([]); pipe; truncateText('x', 1);
`,
  );
  await run(['npx', 'tsc', '--noEmit'], directory);
  for (const peer of ['@modelcontextprotocol/sdk', '@openai/agents']) {
    if (await Bun.file(join(directory, 'node_modules', peer, 'package.json')).exists()) {
      throw new Error(`optional peer ${peer} was installed for the root consumer`);
    }
  }
}

async function verifyRuntime(directory: string, tarball: string): Promise<void> {
  await installConsumer(directory, tarball);
  await Bun.write(
    join(directory, 'run.mjs'),
    `
import assert from 'node:assert/strict';
globalThis.process = undefined; globalThis.Buffer = undefined; globalThis.Bun = undefined;
const armorer = await import('armorer');
const tool = armorer.createTool({ name: 'browser-safe', description: 'x', execute: () => 'ok' });
assert.equal(await tool.execute({}), 'ok');
assert.equal(typeof (await import('armorer/adapters/openai')).toOpenAITools, 'function');
const isolated = await import('armorer/core');
assert.equal(typeof isolated.createRegistry, 'function');
isolated.createRegistry();
console.log('armorer runtime consumer: all assertions passed');
`,
  );
  const nodeResult = await $`${nodeBinary} run.mjs`
    .cwd(directory)
    .env({ ...process.env, ...(realNodePath ? { PATH: realNodePath } : {}) })
    .nothrow()
    .quiet();
  if (nodeResult.exitCode !== 0)
    throw new Error(`node run.mjs failed:\n${nodeResult.stdout}${nodeResult.stderr}`);
  await Bun.write(
    join(directory, 'bun.mjs'),
    `import { createTool } from 'armorer'; const tool = createTool({ name: 'bun', description: 'x', execute: async () => 'ok' }); if (await tool.execute({}) !== 'ok') process.exit(1);`,
  );
  await run(['bun', 'bun.mjs'], directory);
  await Bun.write(
    join(directory, 'cjs.cjs'),
    `const armorer = require('armorer'); if (typeof armorer.createTool !== 'function') process.exit(1);`,
  );
  const cjsResult = await $`${nodeBinary} cjs.cjs`
    .cwd(directory)
    .env({ ...process.env, ...(realNodePath ? { PATH: realNodePath } : {}) })
    .nothrow()
    .quiet();
  if (cjsResult.exitCode !== 0)
    throw new Error(`Node CommonJS consumer failed:\n${cjsResult.stdout}${cjsResult.stderr}`);
}

async function verifyBrowser(directory: string, tarball: string): Promise<void> {
  await installConsumer(directory, tarball, {
    '@sveltejs/adapter-auto': svelteKitVersions.adapterAuto,
    '@sveltejs/kit': svelteKitVersions.kit,
    '@sveltejs/vite-plugin-svelte': svelteKitVersions.viteSveltePlugin,
    esbuild: '0.28.2',
    svelte: svelteKitVersions.svelte,
    typescript: '6.0.3',
    vite: svelteKitVersions.vite,
  });
  const imports = browserSubpaths
    .map(
      (subpath) =>
        `import * as ${subpath === '.' ? 'root' : `subpath${browserSubpaths.indexOf(subpath)}`} from 'armorer${subpath === '.' ? '' : subpath}';`,
    )
    .join('\n');
  await Bun.write(
    join(directory, 'entry.ts'),
    `${imports}\nroot.createToolbox();\nconsole.log('browser exports loaded');\n`,
  );
  await run(
    ['npx', 'esbuild', './entry.ts', '--bundle', '--platform=browser', '--outfile=browser.js'],
    directory,
  );

  await mkdir(join(directory, 'src', 'routes'), { recursive: true });
  await Bun.write(
    join(directory, 'svelte.config.js'),
    `import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default { preprocess: vitePreprocess(), kit: { adapter: adapter() } };
`,
  );
  await Bun.write(
    join(directory, 'vite.config.ts'),
    `import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [sveltekit()] });
`,
  );
  await Bun.write(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      extends: './.svelte-kit/tsconfig.json',
      compilerOptions: { moduleResolution: 'bundler', strict: true },
    }),
  );
  await Bun.write(
    join(directory, 'src', 'app.html'),
    '<!doctype html><html lang="en"><head>%sveltekit.head%</head><body><div style="display: contents">%sveltekit.body%</div></body></html>',
  );
  await Bun.write(
    join(directory, 'src', 'routes', '+page.svelte'),
    `<script lang="ts">
  import { createToolbox } from 'armorer';
  const toolbox = createToolbox();
</script>

<p>{toolbox.size} Armorer tools loaded.</p>
`,
  );
  await run(['npx', 'svelte-kit', 'sync'], directory);
  await run(['npx', 'vite', 'build'], directory);

  const browserArtifacts = ['browser.js'];
  for await (const relativePath of new Bun.Glob('.svelte-kit/output/client/**/*.{js,mjs}').scan({
    cwd: directory,
    onlyFiles: true,
  })) {
    browserArtifacts.push(relativePath);
  }
  const forbiddenBrowserSource = [/\bBun\./, /node:module/, /createRequire\s*\(/];
  for (const relativePath of browserArtifacts) {
    const source = await Bun.file(join(directory, relativePath)).text();
    for (const forbidden of forbiddenBrowserSource) {
      if (forbidden.test(source)) {
        throw new Error(
          `${relativePath} contains server-only implementation matching ${forbidden}`,
        );
      }
    }
  }
}

async function verifyManifest(directory: string, tarball: string): Promise<void> {
  await installConsumer(directory, tarball);
  const manifest = JSON.parse(
    await Bun.file(join(directory, 'node_modules', 'armorer', 'package.json')).text(),
  ) as {
    exports: Record<string, Record<string, string>>;
    engines: Record<string, string>;
  };
  for (const subpath of browserSubpaths)
    if (!manifest.exports[subpath]?.browser)
      throw new Error(`${subpath} must declare browser support`);
  for (const subpath of serverOnlySubpaths)
    if (manifest.exports[subpath]?.browser)
      throw new Error(`${subpath} must not declare browser support`);
  if (manifest.engines.bun !== '>=1.3.13' || manifest.engines.node !== '^20.16.0 || >=22.3.0')
    throw new Error('engine boundaries changed unexpectedly');

  const expectedNodeSupport = new Map([
    ['20.15.1', false],
    ['20.16.0', true],
    ['20.19.9', true],
    ['21.0.0', false],
    ['21.7.3', false],
    ['22.0.0', false],
    ['22.2.0', false],
    ['22.3.0', true],
  ]);
  for (const [version, expected] of expectedNodeSupport) {
    if (Bun.semver.satisfies(version, manifest.engines.node) !== expected) {
      throw new Error(`Node ${version} support must be ${expected}`);
    }
  }
  if (!Bun.semver.satisfies('1.3.13', manifest.engines.bun))
    throw new Error('Bun 1.3.13 must satisfy the declared floor');
  if (Bun.semver.satisfies('1.3.12', manifest.engines.bun))
    throw new Error('Bun 1.3.12 must remain below the declared floor');
}

async function main(): Promise<void> {
  if (Bun.argv.at(-2) !== '--mode' || Bun.argv.at(-1) !== 'local')
    throw new Error('Usage: bun run scripts/verify-armorer-consumer.ts --mode local');
  await run(['turbo', 'run', 'build', '--filter=armorer'], root);
  const staging = await mkdtemp(join(tmpdir(), 'armorer-consumer-pack-'));
  const tarball = await pack(staging);
  const directories = await Promise.all(
    ['types', 'runtime', 'browser', 'manifest'].map((name) =>
      mkdtemp(join(tmpdir(), `armorer-consumer-${name}-`)),
    ),
  );
  try {
    await verifyTypeSurface(directories[0]!, tarball);
    await verifyRuntime(directories[1]!, tarball);
    await verifyBrowser(directories[2]!, tarball);
    await verifyManifest(directories[3]!, tarball);
    console.log(
      'Armorer consumer verification passed: tarball, exports, types, Bun, Node ESM/CJS, browser, and engines.',
    );
  } finally {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
