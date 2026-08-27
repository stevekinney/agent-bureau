import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BROWSER_SUBPATHS,
  FORBIDDEN_BROWSER_OUTPUT,
  packageSpecifier,
  SVELTEKIT_VERSIONS,
  TYPESCRIPT_VERSION,
  ZOD_VERSION,
} from './conversationalist-consumer-contract';

export type BrowserConsumerContext = {
  nodeBinary: string;
  realNodeEnvironment: Record<string, string | undefined>;
  deployVercelPreview: boolean;
};

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
  if (!executable) throw new VerificationFailure(consumer, step, 'empty command');
  const result = await Bun.$`${executable} ${rest}`.cwd(cwd).env(env).nothrow().quiet();
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

export async function verifyBrowserConsumer(
  directory: string,
  tarballPath: string,
  context: BrowserConsumerContext,
): Promise<void> {
  const consumer = 'browser';
  const localTarball = join(directory, 'conversationalist.tgz');
  await copyFile(tarballPath, localTarball);

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
          preview: 'vite preview',
          check: 'svelte-kit sync && svelte-check --tsconfig ./tsconfig.json',
        },
        dependencies: {
          conversationalist: 'file:./conversationalist.tgz',
          zod: ZOD_VERSION,
        },
        devDependencies: {
          '@sveltejs/adapter-vercel': SVELTEKIT_VERSIONS.adapterVercel,
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
    `import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ runtime: 'nodejs22.x' }),
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
    join(directory, 'src', 'routes', '+page.server.ts'),
    `import { Conversation, createConversationHistory, createPublicConversationProjection, defineMessagePlugin } from 'conversationalist';

async function handleTenant(tenant: string, credential: string) {
  const plugin = defineMessagePlugin({ id: 'request-' + tenant, revision: 1 }, (input) => ({
    ...input,
    metadata: { tenantPlugin: tenant },
  }));
  const conversation = new Conversation(
    createConversationHistory({ id: tenant, metadata: { credential } }),
    { plugins: [plugin] },
  );
  conversation.appendUserMessage('Contact ' + tenant + '@example.com with api_key=' + credential);
  const projection = createPublicConversationProjection(conversation.current);
  await conversation.dispose();
  return projection;
}

export async function load() {
  const [tenantA, tenantB] = await Promise.all([
    handleTenant('tenant-a', 'tenant-a-server-credential-123456'),
    handleTenant('tenant-b', 'tenant-b-server-credential-123456'),
  ]);
  return { tenantA, tenantB };
}
`,
  );

  await Bun.write(
    join(directory, 'src', 'lib', 'all-subpaths.ts'),
    `${BROWSER_SUBPATHS.map(
      (subpath, index) => `import * as surface${index} from '${packageSpecifier(subpath)}';`,
    ).join('\n')}

export const publicSurfaces = [${BROWSER_SUBPATHS.map((_, index) => `surface${index}`).join(', ')}];
`,
  );

  await Bun.write(
    join(directory, 'src', 'routes', '+page.svelte'),
    `<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { PageData } from './$types';
  import {
    Conversation,
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
  import { publicSurfaces } from '$lib/all-subpaths';

  export let data: PageData;

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
  const conversation = new Conversation();
  const tenantA = new Conversation(data.tenantA);
  const tenantB = new Conversation(data.tenantB);
  if (tenantA.current.id === tenantB.current.id) throw new Error('SSR tenant histories crossed');
  let snapshot = conversation.getServerSnapshot();
  const unsubscribe = conversation.subscribe(() => {
    snapshot = conversation.getSnapshot();
  });
  onDestroy(() => {
    unsubscribe();
    void conversation.dispose();
    void tenantA.dispose();
    void tenantB.dispose();
  });
</script>

<p>{helpers.length} helpers and {publicSurfaces.length} public surfaces loaded at revision {snapshot.revision} for {tenantA.current.id} and {tenantB.current.id}.</p>
`,
  );

  await runStep(consumer, 'npm install', directory, ['npm', 'install', '--no-audit', '--no-fund']);

  const checkResult = await runStep(consumer, 'bun run check', directory, ['bun', 'run', 'check']);
  const buildResult = await runStep(consumer, 'bun run build', directory, ['bun', 'run', 'build']);

  const vercelConfig = JSON.parse(
    await Bun.file(join(directory, '.vercel', 'output', 'config.json')).text(),
  ) as { version?: number };
  if (vercelConfig.version !== 3) {
    throw new VerificationFailure(
      consumer,
      'Vercel build output',
      'expected Build Output API version 3',
    );
  }

  const previewPort = 43_000 + (process.pid % 1000);
  const preview = Bun.spawn(
    ['bun', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(previewPort)],
    { cwd: directory, stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        response = await fetch(`http://127.0.0.1:${previewPort}/`);
        break;
      } catch {
        await Bun.sleep(500);
      }
    }
    if (
      !response?.ok ||
      !(await response.text()).includes(`${BROWSER_SUBPATHS.length} public surfaces`)
    ) {
      throw new VerificationFailure(
        consumer,
        'Vercel preview smoke',
        'production preview did not render the packed full-controller consumer',
      );
    }
  } finally {
    preview.kill();
    await preview.exited;
  }

  if (context.deployVercelPreview) {
    const deployment = await runStep(consumer, 'Vercel preview deploy', directory, [
      'vercel',
      'deploy',
      '--yes',
      '--name',
      'conversationalist-host-matrix',
    ]);
    const previewUrl = deployment.output.match(/https:\/\/[^\s]+\.vercel\.app/)?.[0];
    if (!previewUrl) {
      throw new VerificationFailure(
        consumer,
        'Vercel preview deploy',
        'CLI returned no preview URL',
      );
    }
    const previewSmoke = await runStep(consumer, 'Vercel preview smoke', directory, [
      'vercel',
      'curl',
      '/',
      '--deployment',
      previewUrl,
      '--yes',
    ]);
    if (!previewSmoke.output.includes(`${BROWSER_SUBPATHS.length} public surfaces`)) {
      throw new VerificationFailure(
        consumer,
        'Vercel preview smoke',
        `deployed preview did not render successfully at ${previewUrl}`,
      );
    }
    console.log(`Vercel preview: ${previewUrl}`);
  }

  await Bun.write(
    join(directory, 'browser-globals.mjs'),
    `globalThis.process = undefined;
globalThis.Bun = undefined;
const surfaces = await Promise.all(${JSON.stringify(BROWSER_SUBPATHS.map(packageSpecifier))}.map((specifier) => import(specifier)));
if (surfaces.length !== ${BROWSER_SUBPATHS.length}) throw new Error('browser subpath import count changed');
const root = surfaces[0];
const conversation = new root.Conversation(root.createConversationHistory({ id: 'browser-runtime' }));
conversation.appendUserMessage('browser execution');
if (conversation.getSnapshot().revision !== 1) throw new Error('full controller did not execute');
console.log('browser-global consumer passed');
`,
  );
  await runStep(
    consumer,
    'browser globals absent',
    directory,
    [context.nodeBinary, 'browser-globals.mjs'],
    {
      ...context.realNodeEnvironment,
      NODE_OPTIONS: '--conditions=browser',
    },
  );

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
