/**
 * External consumer verifier for Conversationalist (AB-31).
 *
 * Builds Conversationalist from the repository root, packs `packages/conversationalist` with
 * `npm pack --json --ignore-scripts`, and installs that exact tarball into three fresh temporary
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
 * Usage: `bun run scripts/verify-conversationalist-consumer.ts --mode local`
 * Exit code 0 = every consumer passed; 1 = any build/pack/install/typecheck/check/build/runtime
 * command failed, or any output assertion failed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

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
    .split(':')
    .filter((segment) => !segment.includes('bun-node-'))
    .join(':'),
};

/** Absolute path to the real Node.js binary, resolved with the filtered `PATH` above. */
const NODE_BINARY = (await $`which node`.env(REAL_NODE_ENV).quiet().text()).trim();

const ZOD_VERSION = '4.4.3';
const TYPESCRIPT_VERSION = '6.0.3';
const SVELTEKIT_VERSIONS = {
  adapterAuto: '7.0.1',
  kit: '2.70.3',
  viteSveltePlugin: '7.3.0',
  svelte: '5.56.9',
  vite: '8.2.1',
};

const FORBIDDEN_BROWSER_OUTPUT = ['node:module', 'externalized for browser compatibility'];

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

/** Packs Conversationalist and returns the absolute path to the produced tarball. */
async function packConversationalist(stagingRoot: string): Promise<string> {
  const packResult = await $`npm pack --json --ignore-scripts --pack-destination ${stagingRoot}`
    .cwd(CONVERSATIONALIST_DIRECTORY)
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
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
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

/** Consumer 2: minimal SvelteKit app proving a clean browser build. */
async function verifyBrowserConsumer(directory: string, tarballPath: string): Promise<void> {
  const consumer = 'browser';

  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        name: 'conversationalist-browser-consumer',
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: {
          dev: 'vite dev',
          build: 'vite build',
          check: 'svelte-kit sync && svelte-check --tsconfig ./tsconfig.json',
        },
        dependencies: {
          conversationalist: `file:${tarballPath}`,
          zod: ZOD_VERSION,
        },
        devDependencies: {
          '@sveltejs/adapter-auto': SVELTEKIT_VERSIONS.adapterAuto,
          '@sveltejs/kit': SVELTEKIT_VERSIONS.kit,
          '@sveltejs/vite-plugin-svelte': SVELTEKIT_VERSIONS.viteSveltePlugin,
          svelte: SVELTEKIT_VERSIONS.svelte,
          'svelte-check': '^4.3.3',
          typescript: TYPESCRIPT_VERSION,
          vite: SVELTEKIT_VERSIONS.vite,
        },
      },
      null,
      2,
    ),
  );

  await Bun.write(
    join(directory, 'svelte.config.js'),
    `import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
  },
};
`,
  );

  await Bun.write(
    join(directory, 'vite.config.ts'),
    `import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
});
`,
  );

  await Bun.write(
    join(directory, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: './.svelte-kit/tsconfig.json',
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          esModuleInterop: true,
          forceConsistentCasingInFileNames: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          sourceMap: true,
          strict: true,
          moduleResolution: 'bundler',
        },
      },
      null,
      2,
    ),
  );

  await Bun.write(
    join(directory, 'src', 'app.d.ts'),
    `declare global {
  namespace App {}
}

export {};
`,
  );

  await Bun.write(
    join(directory, 'src', 'app.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
`,
  );

  await Bun.write(
    join(directory, 'src', 'routes', '+page.svelte'),
    `<script lang="ts">
  import {
    removeMessage,
    replaceToolResult,
    setMessageHidden,
    updateMessage,
  } from 'conversationalist';
  import {
    removeMessage as conversationRemoveMessage,
    replaceToolResult as conversationReplaceToolResult,
    setMessageHidden as conversationSetMessageHidden,
    updateMessage as conversationUpdateMessage,
  } from 'conversationalist/conversation';

  const helpers = [
    updateMessage,
    setMessageHidden,
    replaceToolResult,
    removeMessage,
    conversationUpdateMessage,
    conversationSetMessageHidden,
    conversationReplaceToolResult,
    conversationRemoveMessage,
  ];
</script>

<p>{helpers.length} Conversationalist mutation helpers loaded.</p>
`,
  );

  await runStep(consumer, 'npm install', directory, ['npm', 'install', '--no-audit', '--no-fund']);

  const checkResult = await runStep(consumer, 'bun run check', directory, ['bun', 'run', 'check']);
  const buildResult = await runStep(consumer, 'bun run build', directory, ['bun', 'run', 'build']);

  for (const [step, result] of [
    ['bun run check', checkResult],
    ['bun run build', buildResult],
  ] as const) {
    for (const forbidden of FORBIDDEN_BROWSER_OUTPUT) {
      if (result.output.includes(forbidden)) {
        throw new VerificationFailure(
          consumer,
          step,
          `output contains forbidden string "${forbidden}"\n${result.output}`,
        );
      }
    }
  }
}

/** Consumer 3: plain Node.js runtime proving the mutation helpers behave and stay immutable. */
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
}

const RUNTIME_CONSUMER_SCRIPT = `import assert from 'node:assert/strict';

import {
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
} from 'conversationalist/conversation';

let history = createConversationHistory();
history = appendUserMessage(history, 'Hello');
history = appendToolCall(history, { id: 'external-call', name: 'external_call', arguments: {} });
history = appendToolResult(history, {
  callId: 'external-call',
  outcome: 'action_required',
  content: { pending: true },
  action: { type: 'approval', message: 'Approve?' },
});

assert.equal(history.ids.length, 3, 'expected one user, one tool-call, one tool-result message');

const snapshot = structuredClone(history);
const [userMessageId, , toolResultMessageId] = history.ids;
assert.ok(userMessageId, 'expected a user message id');
assert.ok(toolResultMessageId, 'expected a tool-result message id');

function assertBaselineUnchanged() {
  assert.deepStrictEqual(history, snapshot, 'baseline history mutated in place');
  for (const id of history.ids) {
    assert.deepStrictEqual(history.messages[id], snapshot.messages[id], \`message \${id} mutated in place\`);
  }
}

// updateMessage
const updated = updateMessage(history, userMessageId, { content: 'Updated' });
assert.equal(updated.messages[userMessageId].content, 'Updated');
assertBaselineUnchanged();
assert.deepStrictEqual(validateConversationHistoryIntegrity(updated), []);

// setMessageHidden
const hidden = setMessageHidden(history, userMessageId, true);
assert.equal(hidden.messages[userMessageId].hidden, true);
assertBaselineUnchanged();
assert.deepStrictEqual(validateConversationHistoryIntegrity(hidden), []);

// replaceToolResult
const replacedResult = { callId: 'external-call', outcome: 'success', content: { verified: true } };
const replaced = replaceToolResult(history, 'external-call', replacedResult);
const replacedMessage = Object.values(replaced.messages).find(
  (message) => message.toolResult?.callId === 'external-call',
);
assert.ok(replacedMessage, 'expected a message carrying the replaced tool result');
assert.deepStrictEqual(replacedMessage.toolResult, replacedResult);
assertBaselineUnchanged();
assert.deepStrictEqual(validateConversationHistoryIntegrity(replaced), []);

// removeMessage
const removed = removeMessage(history, toolResultMessageId);
assert.equal(removed.ids.length, 2, 'expected exactly two messages after removal');
assert.equal(removed.messages[removed.ids[0]].position, 0);
assert.equal(removed.messages[removed.ids[1]].position, 1);
assertBaselineUnchanged();
assert.deepStrictEqual(validateConversationHistoryIntegrity(removed), []);

// Unknown identifiers: every helper returns the exact input object unchanged.
assert.strictEqual(updateMessage(history, 'unknown-id', { content: 'x' }), history);
assert.strictEqual(setMessageHidden(history, 'unknown-id', true), history);
assert.strictEqual(replaceToolResult(history, 'unknown-call', replacedResult), history);
assert.strictEqual(removeMessage(history, 'unknown-id'), history);
assertBaselineUnchanged();

console.log('conversationalist runtime consumer: all assertions passed');
`;

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const modeIndex = args.indexOf('--mode');
  const mode = modeIndex === -1 ? undefined : args[modeIndex + 1];

  if (mode !== 'local') {
    console.error('Usage: bun run scripts/verify-conversationalist-consumer.ts --mode local');
    process.exit(1);
  }

  console.log('Building conversationalist from the repository root...');
  await runStep('build', 'turbo run build', REPO_ROOT, [
    'turbo',
    'run',
    'build',
    '--filter=conversationalist',
  ]);

  const stagingRoot = await mkdtemp(join(tmpdir(), 'conversationalist-consumer-'));

  try {
    console.log('Packing conversationalist...');
    const tarballPath = await packConversationalist(stagingRoot);
    console.log(`Packed tarball: ${tarballPath}`);

    const strictTypeDirectory = await mkdtemp(join(tmpdir(), 'conversationalist-strict-type-'));
    const browserDirectory = await mkdtemp(join(tmpdir(), 'conversationalist-browser-'));
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'conversationalist-runtime-'));

    try {
      console.log('Verifying strict-type consumer...');
      await verifyStrictTypeConsumer(strictTypeDirectory, tarballPath);
      console.log('✓ strict-type consumer passed');

      console.log('Verifying browser (SvelteKit) consumer...');
      await verifyBrowserConsumer(browserDirectory, tarballPath);
      console.log('✓ browser consumer passed');

      console.log('Verifying packed runtime consumer...');
      await verifyRuntimeConsumer(runtimeDirectory, tarballPath);
      console.log('✓ runtime consumer passed');
    } finally {
      await rm(strictTypeDirectory, { recursive: true, force: true });
      await rm(browserDirectory, { recursive: true, force: true });
      await rm(runtimeDirectory, { recursive: true, force: true });
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
