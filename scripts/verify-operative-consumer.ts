/**
 * Verifies the published Operative contract from a real npm tarball, in an
 * isolated Bun/TypeScript consumer outside the monorepo workspace (AB-23).
 *
 * Usage:
 *   bun run scripts/verify-operative-consumer.ts --mode local
 *   bun run scripts/verify-operative-consumer.ts --mode registry --version <version>
 *
 * Local mode packs `packages/operative` with `npm pack` and installs that
 * tarball by absolute file path. Registry mode installs
 * `@lostgradient/operative@<version>` from the public npm registry instead —
 * everything else about the consumer and its assertions is identical.
 *
 * Both modes prove: the tarball/release resolves its own transitive
 * dependencies from npm with no `workspace:`/repository-path/override/patch/
 * link resolution anywhere else in the consumer's `bun.lock`; the public
 * surface compiles and runs for direct, inline, barrel, literal
 * dynamic-import, `createLazyAgent`, and `createLazyGenerate` agent
 * definitions; output inference and the `.output()`/`unwrap()` accessor are
 * present only when an `output` schema is supplied; the widened
 * (runtime-computed) dynamic-module path is accepted when well-shaped and
 * rejected at runtime when it is not; and every removed API from AB-15/17/
 * 18/21/22 either fails to compile (types/functions removed from the public
 * surface) or is rejected at runtime (the legacy `structuredOutput`
 * persisted-record field, which was never a compile-time-checked input in
 * the first place). No network provider, external storage service,
 * or credential is used anywhere in local verification — every agent uses a
 * hand-rolled deterministic `GenerateFunction` and an in-memory Armorer
 * toolbox.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

const root = join(import.meta.dir, '..');
const packageDirectory = join(root, 'packages', 'operative');

async function run(command: string[], cwd: string): Promise<string> {
  const [executable, ...arguments_] = command;
  const result = await $`${executable} ${arguments_}`.cwd(cwd).nothrow().quiet();
  const output = `${result.stdout}${result.stderr}`;
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed:\n${output}`);
  return output;
}

/**
 * Like {@link run}, but returns ONLY stdout on success — for a command whose
 * stdout is meant to be parsed as JSON (`npm pack --json`). An ordinary npm
 * config warning on stderr (e.g. `npm warn Unknown env config "http-proxy"`)
 * does not fail the command and must not corrupt the JSON payload the way
 * concatenating stdout+stderr would. On failure the combined output is still
 * included in the thrown error for diagnostics.
 */
async function runForStdout(command: string[], cwd: string): Promise<string> {
  const [executable, ...arguments_] = command;
  const result = await $`${executable} ${arguments_}`.cwd(cwd).nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.toString();
}

/** Runs a command and returns its exit code + combined output without throwing. */
async function runExpectingFailure(
  command: string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const [executable, ...arguments_] = command;
  const result = await $`${executable} ${arguments_}`.cwd(cwd).nothrow().quiet();
  return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
}

async function packLocal(staging: string): Promise<string> {
  const stdout = await runForStdout(
    ['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', staging],
    packageDirectory,
  );
  const filename = (JSON.parse(stdout) as Array<{ filename: string }>)[0]?.filename;
  if (!filename) throw new Error('npm pack produced no tarball');
  return join(staging, filename);
}

// ---------------------------------------------------------------------------
// Consumer source — every fixture is a plain string template written into
// the isolated consumer directory. Nothing here imports from the monorepo:
// the consumer only ever imports `@lostgradient/operative` (the tarball/
// release under test), `armorer`, and `zod` — its own declared dependencies.
// ---------------------------------------------------------------------------

const DETERMINISTIC_GENERATE = `import type { GenerateFunction } from '@lostgradient/operative';

/**
 * A deterministic, local, network-free GenerateFunction: step 0 calls the
 * one tool the toolbox exposes, step 1 returns a JSON string satisfying
 * \`greetingOutputSchema\`. No provider SDK, no network call, no credential.
 */
export function makeDeterministicGenerate(): GenerateFunction {
  let step = 0;
  return async () => {
    step += 1;
    if (step === 1) {
      return {
        content: '',
        toolCalls: [{ name: 'echo', arguments: { message: 'hello' } }],
        usage: { prompt: 10, completion: 5, total: 15 },
      };
    }
    return {
      content: JSON.stringify({ greeting: 'hello, hello' }),
      toolCalls: [],
      usage: { prompt: 8, completion: 4, total: 12 },
    };
  };
}
`;

const TOOLS = `import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

export const echoTool = createTool({
  name: 'echo',
  description: 'Echoes the given message back doubled.',
  input: z.object({ message: z.string() }),
  execute: async ({ message }) => ({ echoed: \`\${message}, \${message}\` }),
});

export function makeToolbox() {
  return createToolbox([echoTool]);
}
`;

const SCHEMAS = `import { z } from 'zod';

export const greetingOutputSchema = z.object({ greeting: z.string() });
export type GreetingOutput = z.infer<typeof greetingOutputSchema>;
`;

// A separate module (not the entry point) so createLazyAgent/createLazyGenerate
// and dynamic-import fixtures have something real to resolve.
const AGENT_MODULE = `import { createAgent } from '@lostgradient/operative';

import { makeDeterministicGenerate } from './generate';
import { greetingOutputSchema } from './schemas';
import { makeToolbox } from './tools';

function buildAgent() {
  return createAgent({
    name: 'module-agent',
    generate: makeDeterministicGenerate(),
    instructions: 'You are a deterministic test agent.',
    toolbox: makeToolbox(),
    output: greetingOutputSchema,
    stopWhen: (context) => context.step >= 2,
  });
}

// Default export — the shape a bare \`import(path)\` unwraps automatically.
export default buildAgent();

// Named export — the shape a barrel/literal dynamic import selects manually.
export const namedAgent = buildAgent();
`;

const GENERATE_MODULE = `import type { GenerateFunction } from '@lostgradient/operative';

import { makeDeterministicGenerate } from './generate';

const generate: GenerateFunction = makeDeterministicGenerate();

export default generate;
`;

// A module that does NOT export a valid RunnableAgent/GenerateFunction shape
// — used to prove the widened dynamic-module runtime guard actually rejects
// a malformed resolution rather than silently accepting it.
const MALFORMED_MODULE = `export default { notAnAgent: true };
export const notAFunction = 'nope';
`;

const DIRECT_DEFINITION = `import { createAgent } from '@lostgradient/operative';

import { makeDeterministicGenerate } from './generate';
import { greetingOutputSchema } from './schemas';
import { makeToolbox } from './tools';

export function directAgent() {
  return createAgent({
    name: 'direct-agent',
    generate: makeDeterministicGenerate(),
    instructions: 'You are a deterministic test agent.',
    toolbox: makeToolbox(),
    output: greetingOutputSchema,
    stopWhen: (context) => context.step >= 2,
  });
}
`;

// "Inline" — the agent is constructed and run in one expression, with no
// intermediate named variable holding the CreateAgentOptions or the agent.
const INLINE_DEFINITION = `import { createAgent } from '@lostgradient/operative';

import { makeDeterministicGenerate } from './generate';
import { greetingOutputSchema } from './schemas';
import { makeToolbox } from './tools';

export async function runInlineAgent() {
  return await createAgent({
    generate: makeDeterministicGenerate(),
    instructions: 'You are a deterministic test agent.',
    toolbox: makeToolbox(),
    output: greetingOutputSchema,
    stopWhen: (context) => context.step >= 2,
  })
    .run('Say hello.')
    .result();
}
`;

const BARREL_DEFINITION = `import * as operative from '@lostgradient/operative';

import { makeDeterministicGenerate } from './generate';
import { greetingOutputSchema } from './schemas';
import { makeToolbox } from './tools';

export function barrelAgent() {
  return operative.createAgent({
    name: 'barrel-agent',
    generate: makeDeterministicGenerate(),
    instructions: 'You are a deterministic test agent.',
    toolbox: makeToolbox(),
    output: greetingOutputSchema,
    stopWhen: (context) => context.step >= 2,
  });
}
`;

// A literal (statically-analyzable) dynamic import specifier — TypeScript
// narrows this to the real module shape, no widening.
const DYNAMIC_LITERAL_DEFINITION = `import { createLazyAgent } from '@lostgradient/operative';

export function literalDynamicImportAgent() {
  return createLazyAgent(() =>
    import('./agent-module').then(({ namedAgent: selected }) => selected),
  );
}
`;

const LAZY_AGENT_DEFINITION = `import { createLazyAgent } from '@lostgradient/operative';

export function lazyAgent() {
  return createLazyAgent(() => import('./agent-module').then((module) => module.default));
}
`;

const LAZY_GENERATE_DEFINITION = `import { createAgent, createLazyGenerate } from '@lostgradient/operative';

import { greetingOutputSchema } from './schemas';
import { makeToolbox } from './tools';

export function agentWithLazyGenerate() {
  const generate = createLazyGenerate(() =>
    import('./generate-module').then((module) => module.default),
  );
  return createAgent({
    name: 'lazy-generate-agent',
    generate,
    instructions: 'You are a deterministic test agent.',
    toolbox: makeToolbox(),
    output: greetingOutputSchema,
    stopWhen: (context) => context.step >= 2,
  });
}
`;

// A runtime-computed (non-literal) import specifier — TypeScript cannot
// narrow this statically, so the loader's static type widens to
// Promise<unknown>. createLazyAgent must validate the RESOLVED value at
// runtime instead. `pluginPath` is computed at call time so nothing here
// is a literal specifier tsc could special-case.
const WIDENED_DEFINITIONS = `import type { RunnableAgent } from '@lostgradient/operative';
import { createLazyAgent, createLazyGenerate } from '@lostgradient/operative';

function resolvePath(name: string): string {
  return \`./\${name}.ts\`;
}

export function widenedValidAgent() {
  const pluginPath = resolvePath('agent-module');
  return createLazyAgent<unknown, boolean>(
    () => import(pluginPath) as Promise<{ default: RunnableAgent<unknown, boolean> }>,
  );
}

export function widenedMalformedAgent() {
  const pluginPath = resolvePath('malformed-module');
  return createLazyAgent<unknown, boolean>(
    () => import(pluginPath) as Promise<{ default: RunnableAgent<unknown, boolean> }>,
  );
}

export function widenedMalformedGenerate() {
  const pluginPath = resolvePath('malformed-module');
  return createLazyGenerate(() => import(pluginPath) as Promise<never>);
}
`;

const TSCONFIG = {
  compilerOptions: {
    strict: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: false,
    module: 'Preserve',
    moduleResolution: 'bundler',
    target: 'ESNext',
    types: ['bun'],
    noEmit: true,
  },
  // `removed/**/*.ts` is deliberately excluded: those probes are checked
  // individually (each expected to FAIL) by verifyRemovedApiProbesFailCompilation.
  include: ['src/**/*.ts', 'test/**/*.ts'],
};

// Each removed-API probe is its own file, and each probe attacks exactly ONE
// removed name, so a `tsc` failure on one probe can never mask another
// probe's own (still-required) failure, and reintroducing any single removed
// name is independently caught. Every field probe below targets the type it
// actually lived on pre-AB-18 (`RunOptions`/`createActiveRun` — confirmed
// against packages/operative/src/types.ts as of the commit immediately
// before AB-18 landed), not `CreateAgentOptions`/`createAgent`, which never
// had these fields at all.
const REMOVED_API_PROBES: Record<string, string> = {
  'removed-response-schema.ts': `import { createActiveRun } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

// 'responseSchema' lived on RunOptions/createActiveRun pre-AB-18, removed
// with no alias — this must be a real, unsuppressed compile error.
createActiveRun({
  generate: async () => ({ content: 'x', toolCalls: [] }),
  toolbox: createToolbox([]),
  conversation: new Conversation(),
  responseSchema: { type: 'object' },
});
`,
  'removed-response-json-schema.ts': `import { createActiveRun } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

// 'responseJsonSchema' — AB-18's companion RunOptions field, also removed.
createActiveRun({
  generate: async () => ({ content: 'x', toolCalls: [] }),
  toolbox: createToolbox([]),
  conversation: new Conversation(),
  responseJsonSchema: { type: 'object' },
});
`,
  'removed-bureau-types.ts': `import type { Anything } from '@lostgradient/operative/bureau-types';

export type Probe = Anything;
`,
  'removed-agent-registry.ts': `import { AgentRegistry } from '@lostgradient/operative';

export { AgentRegistry };
`,
  'removed-create-agent-registry.ts': `import { createAgentRegistry } from '@lostgradient/operative';

export { createAgentRegistry };
`,
  'removed-create-bureau-runtime.ts': `import { createBureauRuntime } from '@lostgradient/operative';

export { createBureauRuntime };
`,
  'removed-registry-agent.ts': `import { RegistryAgent } from '@lostgradient/operative';

export { RegistryAgent };
`,
};

const OUTPUT_INFERENCE_TYPE_CHECKS = `// Compile-time-only checks: output inference and accessor availability.
// This file is never executed — only type-checked.
import { createAgent } from '@lostgradient/operative';

import { makeDeterministicGenerate } from './generate';
import type { GreetingOutput } from './schemas';
import { greetingOutputSchema } from './schemas';
import { makeToolbox } from './tools';

async function typedOutputAccessor(): Promise<void> {
  const typed = createAgent({
    generate: makeDeterministicGenerate(),
    toolbox: makeToolbox(),
    output: greetingOutputSchema,
  });
  const run = typed.run('hi');
  // .output() exists and is typed as Promise<GreetingOutput> when an output
  // schema was supplied (H = true).
  const output: GreetingOutput = await run.output();
  const result = await run.result();
  if (result.output !== undefined) {
    const inferred: GreetingOutput = result.output;
    void inferred;
  }
  void output;
}

async function untypedNoOutputAccessor(): Promise<void> {
  const untyped = createAgent({
    generate: makeDeterministicGenerate(),
    toolbox: makeToolbox(),
  });
  const run = untyped.run('hi');
  // No output schema was supplied (H = false) — .output() must not exist on
  // this handle's type at all.
  // @ts-expect-error — untyped agents have no .output() accessor.
  void run.output;
  const result = await run.result();
  void result;
}

void typedOutputAccessor;
void untypedNoOutputAccessor;
`;

const SMOKE_TEST = `import {
  AgentContractError,
  AsyncDefinitionLoadError,
  parseRunFrame,
  UnsupportedRunResultLegacyFieldError,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { barrelAgent } from '../src/barrel';
import { directAgent } from '../src/direct';
import { literalDynamicImportAgent } from '../src/dynamic-literal';
import { runInlineAgent } from '../src/inline';
import { lazyAgent } from '../src/lazy-agent';
import { agentWithLazyGenerate } from '../src/lazy-generate';
import {
  widenedMalformedAgent,
  widenedMalformedGenerate,
  widenedValidAgent,
} from '../src/widened';

describe('direct, inline, barrel, and literal dynamic-import definitions', () => {
  it('runs a directly-defined agent to completion with validated output', async () => {
    const result = await directAgent().run('Say hello.').result();
    expect(result.finishReason).toBe('stop-condition');
    expect(result.output).toEqual({ greeting: 'hello, hello' });
  });

  it('runs an inline agent definition (no intermediate variable) to completion', async () => {
    const result = await runInlineAgent();
    expect(result.finishReason).toBe('stop-condition');
    expect(result.output).toEqual({ greeting: 'hello, hello' });
  });

  it('runs a barrel-imported (import * as operative) agent definition to completion', async () => {
    const result = await barrelAgent().run('Say hello.').result();
    expect(result.finishReason).toBe('stop-condition');
    expect(result.output).toEqual({ greeting: 'hello, hello' });
  });

  it('runs an agent loaded through a literal dynamic import via createLazyAgent', async () => {
    const agent = literalDynamicImportAgent();
    const result = await agent.run('Say hello.').result();
    expect(result.finishReason).toBe('stop-condition');
    expect(result.output).toEqual({ greeting: 'hello, hello' });
  });
});

describe('createLazyAgent and createLazyGenerate', () => {
  it('runs an agent loaded through createLazyAgent from a default export', async () => {
    const agent = lazyAgent();
    const result = await agent.run('Say hello.').result();
    expect(result.finishReason).toBe('stop-condition');
    expect(result.output).toEqual({ greeting: 'hello, hello' });
  });

  it('runs an agent whose GenerateFunction is loaded through createLazyGenerate', async () => {
    const agent = agentWithLazyGenerate();
    const result = await agent.run('Say hello.').result();
    expect(result.finishReason).toBe('stop-condition');
    expect(result.output).toEqual({ greeting: 'hello, hello' });
  });
});

describe('widened (runtime-computed) dynamic-module specifiers', () => {
  it('accepts a well-shaped module even though the loader type widened to unknown', async () => {
    const agent = widenedValidAgent();
    const result = await agent.run('Say hello.').result();
    expect(result.finishReason).toBe('stop-condition');
  });

  it('settles a malformed createLazyAgent resolution as a synthetic error result carrying AgentContractError', async () => {
    const agent = widenedMalformedAgent();
    const run = agent.run('Say hello.');
    const result = await run.result();
    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(AgentContractError);
  });

  it('rejects a malformed createLazyGenerate resolution at runtime with AsyncDefinitionLoadError', async () => {
    const generate = widenedMalformedGenerate();
    await expect(generate({} as never)).rejects.toBeInstanceOf(AsyncDefinitionLoadError);
  });
});

describe('removed structured-output legacy field (AB-18)', () => {
  // 'structuredOutput' was never a CreateAgentOptions/createAgent input field
  // — it is a legacy PERSISTED-RECORD field a durable run's report could
  // carry pre-AB-18. Removal is enforced at the parseRunFrame() runtime
  // boundary (packages/operative/src/run-envelope.ts), not by TypeScript, so
  // this is a runtime probe rather than a compile-failure one like the other
  // removed APIs.
  it('rejects a run-finished frame report carrying the legacy structuredOutput field', () => {
    expect(() =>
      parseRunFrame({
        type: 'run-finished',
        runId: 'probe',
        timestamp: Date.now(),
        schemaVersion: 1,
        report: { structuredOutput: { some: 'legacy value' } },
      }),
    ).toThrow(UnsupportedRunResultLegacyFieldError);
  });
});
`;

async function writeConsumerSource(directory: string): Promise<void> {
  await Bun.write(join(directory, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2));
  await Bun.write(join(directory, 'src', 'generate.ts'), DETERMINISTIC_GENERATE);
  await Bun.write(join(directory, 'src', 'tools.ts'), TOOLS);
  await Bun.write(join(directory, 'src', 'schemas.ts'), SCHEMAS);
  await Bun.write(join(directory, 'src', 'agent-module.ts'), AGENT_MODULE);
  await Bun.write(join(directory, 'src', 'generate-module.ts'), GENERATE_MODULE);
  await Bun.write(join(directory, 'src', 'malformed-module.ts'), MALFORMED_MODULE);
  await Bun.write(join(directory, 'src', 'direct.ts'), DIRECT_DEFINITION);
  await Bun.write(join(directory, 'src', 'inline.ts'), INLINE_DEFINITION);
  await Bun.write(join(directory, 'src', 'barrel.ts'), BARREL_DEFINITION);
  await Bun.write(join(directory, 'src', 'dynamic-literal.ts'), DYNAMIC_LITERAL_DEFINITION);
  await Bun.write(join(directory, 'src', 'lazy-agent.ts'), LAZY_AGENT_DEFINITION);
  await Bun.write(join(directory, 'src', 'lazy-generate.ts'), LAZY_GENERATE_DEFINITION);
  await Bun.write(join(directory, 'src', 'widened.ts'), WIDENED_DEFINITIONS);
  await Bun.write(join(directory, 'src', 'type-checks.ts'), OUTPUT_INFERENCE_TYPE_CHECKS);
  await Bun.write(join(directory, 'test', 'smoke.test.ts'), SMOKE_TEST);
  for (const [filename, content] of Object.entries(REMOVED_API_PROBES)) {
    await Bun.write(join(directory, 'removed', filename), content);
  }
}

/** Bare-package deps every consumer file needs: armorer + zod (declared directly, not left phantom). */
const CONSUMER_DEPENDENCY_RANGES = { armorer: '^2.3.0', zod: '^4.4.3' };

async function writeConsumerManifest(directory: string, operativeSpecifier: string): Promise<void> {
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        name: 'operative-consumer-check',
        private: true,
        type: 'module',
        dependencies: {
          '@lostgradient/operative': operativeSpecifier,
          ...CONSUMER_DEPENDENCY_RANGES,
        },
        devDependencies: { typescript: '6.0.3', '@types/bun': '1.3.14' },
      },
      null,
      2,
    ),
  );
}

/**
 * Parses `bun.lock`'s `"packages"` block with a targeted line scan (the
 * lockfile is JSON5-ish — trailing commas — so a plain `JSON.parse` doesn't
 * round-trip it) and asserts: `@lostgradient/operative` resolves to the
 * expected local tarball path (local mode) or registry version (registry
 * mode), and every OTHER resolved package carries a plain semver version
 * with no `workspace:`, `link:`, `patch:`, or local filesystem path.
 */
async function verifyLockfile(
  directory: string,
  mode: 'local' | 'registry',
  expected: { tarball?: string; version?: string },
): Promise<void> {
  const lockText = await Bun.file(join(directory, 'bun.lock')).text();
  const packagesStart = lockText.indexOf('"packages": {');
  if (packagesStart === -1) throw new Error('bun.lock has no "packages" block');
  const lines = lockText
    .slice(packagesStart)
    .split('\n')
    .filter((line) => /^\s*"[^"]+":\s*\[/.test(line));

  let sawOperative = false;
  for (const line of lines) {
    const nameMatch = /^\s*"([^"]+)":/.exec(line);
    const name = nameMatch?.[1];
    if (!name) throw new Error(`Could not parse package name from bun.lock line: ${line}`);

    if (name === '@lostgradient/operative') {
      sawOperative = true;
      if (mode === 'local') {
        if (!expected.tarball || !line.includes(expected.tarball)) {
          throw new Error(
            `@lostgradient/operative did not resolve to the local tarball ${expected.tarball}:\n${line}`,
          );
        }
      } else {
        if (!expected.version || !line.includes(`@lostgradient/operative@${expected.version}"`)) {
          throw new Error(
            `@lostgradient/operative did not resolve to registry version ${expected.version}:\n${line}`,
          );
        }
      }
      continue;
    }

    // Positively assert a plain registry semver rather than blacklisting
    // known non-registry substrings: a local tarball/directory resolution
    // outside the repository root (`name@/tmp/dependency.tgz`, an absolute
    // path with no `file:`/`workspace:`/`link:`/`patch:` prefix at all —
    // see verify-bureau-tarball-boundary.ts's own doc comment on this exact
    // lockfile shape) would pass a substring blacklist while still being
    // exactly the non-registry resolution this check exists to reject.
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const specMatch = new RegExp(`"${escapedName}@([^"]+)"`).exec(line);
    const resolvedSpec = specMatch?.[1];
    if (
      !resolvedSpec ||
      !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(resolvedSpec)
    ) {
      throw new Error(
        `${name} did not resolve to a plain registry semver in bun.lock (got "${resolvedSpec}"):\n${line}`,
      );
    }
  }
  if (!sawOperative) throw new Error('bun.lock never resolved @lostgradient/operative at all');
}

async function verifyRemovedApiProbesFailCompilation(directory: string): Promise<void> {
  for (const filename of Object.keys(REMOVED_API_PROBES)) {
    const relativePath = join('removed', filename);
    const result = await runExpectingFailure(
      [
        'bunx',
        'tsc',
        '--noEmit',
        '--strict',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        '--target',
        'esnext',
        relativePath,
      ],
      directory,
    );
    if (result.exitCode === 0) {
      throw new Error(
        `Removed-API probe ${relativePath} unexpectedly compiled — the removed surface still exists:\n${result.output}`,
      );
    }
  }
}

async function verifyConsumer(
  directory: string,
  mode: 'local' | 'registry',
  operativeSpecifier: string,
  expected: { tarball?: string; version?: string },
): Promise<void> {
  await writeConsumerManifest(directory, operativeSpecifier);
  await writeConsumerSource(directory);

  // Produces bun.lock — a fresh consumer has none yet.
  await run(['bun', 'install'], directory);
  // The reproducibility assertion the issue names explicitly.
  await run(['bun', 'install', '--frozen-lockfile'], directory);
  await verifyLockfile(directory, mode, expected);

  await run(['bunx', 'tsc', '--noEmit'], directory);
  await run(['bun', 'test'], directory);
  await verifyRemovedApiProbesFailCompilation(directory);
}

async function main(): Promise<void> {
  const modeIndex = Bun.argv.indexOf('--mode');
  const mode = modeIndex !== -1 ? Bun.argv[modeIndex + 1] : undefined;
  if (mode !== 'local' && mode !== 'registry') {
    throw new Error(
      'Usage: bun run scripts/verify-operative-consumer.ts --mode local\n' +
        '       bun run scripts/verify-operative-consumer.ts --mode registry --version <version>',
    );
  }

  if (mode === 'local') {
    await run(['turbo', 'run', 'build', '--filter=@lostgradient/operative'], root);
    await run(['bun', 'run', 'scripts/check-package-shape.ts', 'operative'], root);

    const staging = await mkdtemp(join(tmpdir(), 'operative-consumer-pack-'));
    const directory = await mkdtemp(join(tmpdir(), 'operative-consumer-local-'));
    try {
      const tarball = await packLocal(staging);
      await verifyConsumer(directory, 'local', `file:${tarball}`, { tarball });
      console.log(
        'Operative consumer verification (local) passed: tarball, lockfile boundary, ' +
          'direct/inline/barrel/dynamic-import/lazy definitions, output inference, ' +
          'widened-module runtime guards, and removed-API compile failures.',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
    return;
  }

  const versionIndex = Bun.argv.indexOf('--version');
  const version = versionIndex !== -1 ? Bun.argv[versionIndex + 1] : undefined;
  if (!version) {
    throw new Error(
      'Usage: bun run scripts/verify-operative-consumer.ts --mode registry --version <version>',
    );
  }

  const directory = await mkdtemp(join(tmpdir(), 'operative-consumer-registry-'));
  try {
    await verifyConsumer(directory, 'registry', `${version}`, { version });
    console.log(
      `Operative consumer verification (registry, @lostgradient/operative@${version}) passed.`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
