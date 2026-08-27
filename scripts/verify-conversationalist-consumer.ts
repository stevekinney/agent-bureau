/**
 * External consumer verifier for Conversationalist (AB-31).
 *
 * In `local` mode, builds Conversationalist from the repository root and packs the workspace
 * package. In `published` mode, downloads the requested registry version with `npm pack`. It then
 * installs that exact tarball into three fresh temporary
 * consumers created OUTSIDE the workspace (under the OS temp directory, never under this repo),
 * so none of them can resolve anything through Bun/npm workspace linking:
 *
 *   1. `strict-type` — a strict, `skipLibCheck: false` TypeScript consumer that installs the
 *      tarball and `zod`, but never installs the optional `@anthropic-ai/sdk` peer. Proves the
 *      root and `conversation` entry points type-check without that peer installed.
 *   2. `browser` — a minimal SvelteKit app (adapter-auto/kit/vite-plugin-svelte/svelte/vite all
 *      pinned) that imports the same helpers from both entry points. Proves `bun run check` and
 *      `bun run build` succeed and that neither ever externalizes a Node builtin for the browser.
 *   3. `runtime` — a plain Node.js (not Bun) ESM script that builds a deterministic conversation
 *      history and exercises the four mutation helpers against it, asserting behavior and
 *      immutability with `node:assert`.
 *
 * Usage:
 *   `bun run scripts/verify-conversationalist-consumer.ts --mode local`
 *   `bun run scripts/verify-conversationalist-consumer.ts --mode published --version <version>`
 * Exit code 0 = every consumer passed; 1 = any build/pack/install/typecheck/check/build/runtime
 * command failed, or any output assertion failed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { $ } from 'bun';

import { verifyBrowserConsumer } from './conversationalist-browser-consumer';
import {
  NODE_RANGE,
  PUBLIC_SUBPATHS,
  TYPESCRIPT_VERSION,
  ZOD_VERSION,
} from './conversationalist-consumer-contract';
import { RUNTIME_CONSUMER_SCRIPT } from './conversationalist-runtime-consumer';

const REPO_ROOT = join(import.meta.dir, '..');
const CONVERSATIONALIST_DIRECTORY = join(REPO_ROOT, 'packages', 'conversationalist');

/**
 * `process.env.PATH` with Bun's synthetic `node`-emulation shim directories removed. This repo's
 * root `bunfig.toml` sets `[run].bun = true`, which makes Bun lazily create a temp directory
 * containing a fake `node` (actually Bun) and can end up first on `PATH` — invisibly, since it even
 * reports a spoofed Node version. The packed runtime consumer must run under genuine Node, so every
 * lookup/spawn of `node` for it uses this filtered environment instead of the inherited one.
 */
const REAL_NODE_ENV: Record<string, string | undefined> = {
  ...process.env,
  PATH: (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter((segment) => !segment.includes('bun-node-'))
    .join(delimiter),
};

/** Absolute path to the real Node.js binary, resolved with the filtered `PATH` above. */
const resolvedNodeBinary = Bun.which('node', { PATH: REAL_NODE_ENV['PATH'] ?? '' });
if (!resolvedNodeBinary) {
  throw new Error('Could not locate a "node" executable on PATH (after filtering Bun\'s shim).');
}
const NODE_BINARY: string = resolvedNodeBinary;

type StepResult = { command: string; exitCode: number; output: string };

class VerificationFailure extends Error {
  constructor(
    readonly consumer: string,
    readonly step: string,
    detail: string,
  ) {
    super(`[${consumer}] ${step}: ${detail}`);
  }
}

async function runStep(
  consumer: string,
  step: string,
  cwd: string,
  command: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<StepResult> {
  const [executable, ...rest] = command;
  if (!executable) {
    throw new VerificationFailure(consumer, step, 'empty command');
  }
  const result = await $`${executable} ${rest}`.cwd(cwd).env(env).nothrow().quiet();
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) {
    throw new VerificationFailure(
      consumer,
      step,
      `command "${command.join(' ')}" exited ${result.exitCode}\n${output}`,
    );
  }
  return { command: command.join(' '), exitCode: result.exitCode, output };
}

/** Packs a local or published Conversationalist package and returns its absolute tarball path. */
async function packConversationalist(
  stagingRoot: string,
  publishedVersion?: string,
): Promise<string> {
  const packageSpecifier = publishedVersion
    ? `conversationalist@${publishedVersion}`
    : CONVERSATIONALIST_DIRECTORY;
  const packResult =
    await $`npm pack ${packageSpecifier} --json --ignore-scripts --pack-destination ${stagingRoot}`
      .cwd(REPO_ROOT)
      .nothrow()
      .quiet();
  if (packResult.exitCode !== 0) {
    throw new VerificationFailure(
      'pack',
      'npm pack',
      `exited ${packResult.exitCode}\n${packResult.stderr.toString()}`,
    );
  }

  let packedName: string | undefined;
  try {
    const parsed = JSON.parse(packResult.stdout.toString()) as Array<{ filename?: string }>;
    packedName = parsed[0]?.filename;
  } catch {
    throw new VerificationFailure(
      'pack',
      'npm pack',
      `--json output was not valid JSON:\n${packResult.stdout.toString()}`,
    );
  }
  if (!packedName) {
    throw new VerificationFailure('pack', 'npm pack', 'produced no tarball filename');
  }

  const tarballOnDisk = packedName.replace(/^@/, '').replace(/\//g, '-');
  return join(stagingRoot, tarballOnDisk);
}

/** Consumer 1: strict TypeScript type-check without the optional `@anthropic-ai/sdk` peer. */
async function verifyStrictTypeConsumer(directory: string, tarballPath: string): Promise<void> {
  const consumer = 'strict-type';

  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        name: 'conversationalist-strict-type-consumer',
        private: true,
        version: '0.0.0',
        type: 'module',
        dependencies: {
          conversationalist: `file:${tarballPath}`,
          zod: ZOD_VERSION,
        },
        devDependencies: {
          typescript: TYPESCRIPT_VERSION,
        },
      },
      null,
      2,
    ),
  );

  await Bun.write(
    join(directory, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          module: 'Preserve',
          moduleResolution: 'bundler',
          target: 'ESNext',
          noEmit: true,
        },
        include: ['src'],
      },
      null,
      2,
    ),
  );

  await Bun.write(
    join(directory, 'src', 'index.ts'),
    `import {
  Conversation,
  defineMessagePlugin,
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
  type ConversationStoreSnapshot,
  type MessageUpdate,
} from 'conversationalist';
import {
  removeMessage as conversationRemoveMessage,
  replaceToolResult as conversationReplaceToolResult,
  setMessageHidden as conversationSetMessageHidden,
  updateMessage as conversationUpdateMessage,
  validateConversationHistoryIntegrity as conversationValidateConversationHistoryIntegrity,
  type MessageUpdate as ConversationMessageUpdate,
} from 'conversationalist/conversation';

export const rootHelpers = {
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
};

export const conversationHelpers = {
  removeMessage: conversationRemoveMessage,
  replaceToolResult: conversationReplaceToolResult,
  setMessageHidden: conversationSetMessageHidden,
  updateMessage: conversationUpdateMessage,
  validateConversationHistoryIntegrity: conversationValidateConversationHistoryIntegrity,
};

export const rootUpdate: MessageUpdate = {};
export const conversationUpdate: ConversationMessageUpdate = {};
const controller = new Conversation();
export const externalStoreSnapshot: ConversationStoreSnapshot = controller.getSnapshot();
export const unsubscribe = controller.subscribe(() => controller.getSnapshot());
export const plugin = defineMessagePlugin(
  { id: 'consumer-policy', revision: 1 },
  (input) => input,
);
`,
  );

  await runStep(consumer, 'npm install', directory, ['npm', 'install', '--no-audit', '--no-fund']);

  const tscBin = Bun.file(join(directory, 'node_modules', '.bin', 'tsc'));
  if (!(await tscBin.exists())) {
    throw new VerificationFailure(
      consumer,
      'npm install',
      'node_modules/.bin/tsc was not installed locally; `bunx tsc` would have to download it',
    );
  }

  const installedAnthropicSdk = Bun.file(
    join(directory, 'node_modules', '@anthropic-ai', 'sdk', 'package.json'),
  );
  if (await installedAnthropicSdk.exists()) {
    throw new VerificationFailure(
      consumer,
      'npm install',
      '@anthropic-ai/sdk was installed; this consumer must prove the type surface works without it',
    );
  }

  await runStep(consumer, 'bunx tsc --noEmit', directory, ['bunx', 'tsc', '--noEmit']);
}

/** Packed Node.js and Bun runtime consumer. */
async function verifyRuntimeConsumer(directory: string, tarballPath: string): Promise<void> {
  const consumer = 'runtime';

  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        name: 'conversationalist-runtime-consumer',
        private: true,
        version: '0.0.0',
        type: 'module',
        dependencies: {
          conversationalist: `file:${tarballPath}`,
          zod: ZOD_VERSION,
        },
      },
      null,
      2,
    ),
  );

  await Bun.write(join(directory, 'run.mjs'), RUNTIME_CONSUMER_SCRIPT);

  await runStep(consumer, 'npm install', directory, ['npm', 'install', '--no-audit', '--no-fund']);
  await runStep(consumer, 'node run.mjs', directory, [NODE_BINARY, 'run.mjs'], REAL_NODE_ENV);
  for (const nodeVersion of ['20.19.0', '22.12.0', '24.0.0']) {
    await runStep(consumer, `Node ${nodeVersion} run.mjs`, directory, [
      'npx',
      '--yes',
      `node@${nodeVersion}`,
      'run.mjs',
    ]);
  }
  await runStep(consumer, 'bun run.mjs', directory, ['bun', 'run.mjs']);
}

async function verifyManifestConsumer(directory: string, tarballPath: string): Promise<void> {
  const consumer = 'manifest';
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        name: 'conversationalist-manifest-consumer',
        private: true,
        dependencies: { conversationalist: `file:${tarballPath}`, zod: ZOD_VERSION },
      },
      null,
      2,
    ),
  );
  await runStep(consumer, 'npm install', directory, ['npm', 'install', '--no-audit', '--no-fund']);
  const installedPackage = join(directory, 'node_modules', 'conversationalist');
  const manifest = JSON.parse(await Bun.file(join(installedPackage, 'package.json')).text()) as {
    type: string;
    exports: Record<string, Record<string, string | null>>;
    engines: { bun: string; node: string };
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
    conversationalistSupport: {
      module: string;
      browserGlobals: string[];
      optionalProviderPeers: string[];
      svelteKit: { adapter: string; runtime: string };
      subpaths: Record<string, { browser: boolean; node: boolean; bun: boolean; ssr: boolean }>;
    };
  };
  if (manifest.type !== 'module' || manifest.conversationalistSupport.module !== 'esm') {
    throw new VerificationFailure(consumer, 'support matrix', 'package must be ESM-only');
  }
  if (manifest.engines.bun !== '>=1.3.13' || manifest.engines.node !== NODE_RANGE) {
    throw new VerificationFailure(
      consumer,
      'support matrix',
      'engine boundaries changed unexpectedly',
    );
  }
  const expectedSubpaths = [...PUBLIC_SUBPATHS].sort();
  if (JSON.stringify(Object.keys(manifest.exports).sort()) !== JSON.stringify(expectedSubpaths)) {
    throw new VerificationFailure(consumer, 'support matrix', 'public subpath inventory changed');
  }
  if (
    JSON.stringify(Object.keys(manifest.conversationalistSupport.subpaths).sort()) !==
    JSON.stringify(expectedSubpaths)
  ) {
    throw new VerificationFailure(
      consumer,
      'support matrix',
      'support matrix does not match exports',
    );
  }
  for (const subpath of PUBLIC_SUBPATHS) {
    const conditions = manifest.exports[subpath];
    const support = manifest.conversationalistSupport.subpaths[subpath];
    if (!conditions || !support || !support.node || !support.bun || !support.ssr) {
      throw new VerificationFailure(
        consumer,
        'support matrix',
        `${subpath} is missing required host support`,
      );
    }
    if (
      (support.browser && typeof conditions.browser !== 'string') ||
      (!support.browser && conditions.browser !== null)
    ) {
      throw new VerificationFailure(
        consumer,
        'support matrix',
        `${subpath} browser condition disagrees with the matrix`,
      );
    }
    for (const condition of [
      'bun',
      ...(support.browser ? ['browser'] : []),
      'import',
      'default',
      'types',
    ]) {
      const target = conditions[condition];
      if (!target || !(await Bun.file(join(installedPackage, target)).exists())) {
        throw new VerificationFailure(
          consumer,
          'tarball exports',
          `${subpath} ${condition} target is missing`,
        );
      }
    }
  }
  if (
    manifest.peerDependenciesMeta['@anthropic-ai/sdk']?.optional !== true ||
    !manifest.conversationalistSupport.optionalProviderPeers.includes('@anthropic-ai/sdk')
  ) {
    throw new VerificationFailure(
      consumer,
      'optional peers',
      '@anthropic-ai/sdk must remain optional and explicit',
    );
  }
  for (const [version, expected] of new Map([
    ['20.18.9', false],
    ['20.19.0', true],
    ['21.7.3', false],
    ['22.11.0', false],
    ['22.12.0', true],
    ['23.11.1', false],
    ['24.0.0', true],
  ])) {
    if (Bun.semver.satisfies(version, manifest.engines.node) !== expected) {
      throw new VerificationFailure(
        consumer,
        'Node range',
        `Node ${version} support must be ${expected}`,
      );
    }
  }
  if (
    !Bun.semver.satisfies('1.3.13', manifest.engines.bun) ||
    Bun.semver.satisfies('1.3.12', manifest.engines.bun)
  ) {
    throw new VerificationFailure(consumer, 'Bun floor', 'Bun boundary is not exact');
  }
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const modeIndex = args.indexOf('--mode');
  const mode = modeIndex === -1 ? undefined : args[modeIndex + 1];
  const versionIndex = args.indexOf('--version');
  const publishedVersion = versionIndex === -1 ? undefined : args[versionIndex + 1];
  const deployVercelPreview = args.includes('--vercel-preview');

  if ((mode !== 'local' && mode !== 'published') || (mode === 'published' && !publishedVersion)) {
    console.error(
      'Usage: bun run scripts/verify-conversationalist-consumer.ts --mode local [--vercel-preview]\n' +
        '   or: bun run scripts/verify-conversationalist-consumer.ts --mode published --version <version> [--vercel-preview]',
    );
    process.exit(1);
  }

  if (mode === 'local') {
    console.log('Building conversationalist from the repository root...');
    await runStep('build', 'turbo run build', REPO_ROOT, [
      'turbo',
      'run',
      'build',
      '--filter=conversationalist',
    ]);
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), 'conversationalist-consumer-'));

  try {
    console.log(
      mode === 'published'
        ? `Downloading conversationalist@${publishedVersion} from the npm registry...`
        : 'Packing conversationalist...',
    );
    const tarballPath = await packConversationalist(stagingRoot, publishedVersion);
    console.log(`Packed tarball: ${tarballPath}`);

    const strictTypeDirectory = await mkdtemp(join(tmpdir(), 'conversationalist-strict-type-'));
    const browserDirectory = await mkdtemp(join(tmpdir(), 'conversationalist-browser-'));
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'conversationalist-runtime-'));
    const manifestDirectory = await mkdtemp(join(tmpdir(), 'conversationalist-manifest-'));

    try {
      console.log('Verifying strict-type consumer...');
      await verifyStrictTypeConsumer(strictTypeDirectory, tarballPath);
      console.log('✓ strict-type consumer passed');

      console.log('Verifying browser (SvelteKit) consumer...');
      await verifyBrowserConsumer(browserDirectory, tarballPath, {
        nodeBinary: NODE_BINARY,
        realNodeEnvironment: REAL_NODE_ENV,
        deployVercelPreview,
      });
      console.log('✓ browser consumer passed');

      console.log('Verifying packed runtime consumer...');
      await verifyRuntimeConsumer(runtimeDirectory, tarballPath);
      console.log('✓ runtime consumer passed');

      console.log('Verifying manifest and host support matrix...');
      await verifyManifestConsumer(manifestDirectory, tarballPath);
      console.log('✓ manifest and host support matrix passed');
    } finally {
      await rm(strictTypeDirectory, { recursive: true, force: true });
      await rm(browserDirectory, { recursive: true, force: true });
      await rm(runtimeDirectory, { recursive: true, force: true });
      await rm(manifestDirectory, { recursive: true, force: true });
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  console.log('\n✓ All conversationalist consumer verifications passed.');
}

main().catch((error: unknown) => {
  if (error instanceof VerificationFailure) {
    console.error(`\n✖ conversationalist consumer verification FAILED: ${error.message}`);
  } else {
    console.error('\n✖ conversationalist consumer verification FAILED with an unexpected error:');
    console.error(error);
  }
  process.exit(1);
});
