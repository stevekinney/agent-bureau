/**
 * Verifies the published Operative contract from a real npm tarball, in an
 * isolated Bun/TypeScript consumer outside the monorepo workspace (AB-23).
 *
 * Usage:
 *   bun run scripts/verify-operative-consumer.ts --mode local [--pack-siblings]
 *   bun run scripts/verify-operative-consumer.ts --mode registry --version <version>
 *
 * Local mode packs `packages/operative` with `npm pack` and installs that
 * tarball by absolute file path. Registry mode installs
 * `@lostgradient/operative@<version>` from the public npm registry instead —
 * everything else about the consumer and its assertions is identical.
 *
 * AB-287: local mode proves the artifact boundary, not the registry state.
 * Operative's workspace-sibling dependencies (currently `armorer` and
 * `conversationalist` — detected dynamically from `packages/operative`'s own
 * `dependencies`, matched against every `packages/*` manifest's `name`) can
 * have source ahead of what is published: a coordinated cross-package change
 * lands in the sibling's source before a Version Packages pull request ever
 * publishes it, and registry-resolving that sibling in the isolated consumer
 * would compile against the STALE published surface. For each sibling, this
 * script packs it locally instead of letting it resolve from the registry
 * when: its exact workspace version string is not among the registry's
 * published versions (`npm view <name> versions --json`; a 404 for a
 * never-published package counts as "not on the registry"); OR a pending
 * `.changeset/*.md` targets it (the version string alone cannot see a
 * changeset that bumps a version identical to what is already published —
 * exactly AB-243's `conversationalist@1.1.0` case, where source drifted
 * ahead of the registry with no version bump yet); OR `--pack-siblings` is
 * passed, which forces every sibling to be packed regardless of the above.
 * A packed sibling is installed into the consumer by absolute tarball path
 * (`npm pack --ignore-scripts`, same as operative itself), and the lockfile
 * assertion requires EVERY resolved occurrence of that package name —
 * including a nested, importer-prefixed key Bun did not dedupe — to point at
 * the tarball, not only the first one found. A sibling that needs no packing
 * keeps resolving from the registry with the existing plain-semver
 * assertion. Registry mode is unaffected: it never packs anything.
 *
 * Both modes prove: the tarball/release resolves its own transitive
 * dependencies from npm with no `workspace:`/repository-path/override/patch/
 * link resolution anywhere else in the consumer's `bun.lock` (aside from a
 * packed sibling's own tarball path, which is asserted separately); the
 * public surface compiles and runs for direct, inline, barrel, literal
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
 *
 * AB-259: the `@lostgradient/operative/test` subpath gets its own probe,
 * type-checked with its own `tsc` invocation and then actually executed —
 * not merely compiled — driving a real agent run (scripted generate +
 * scripted tool) through a `ResourceScope`, asserting the recorded
 * normalized causal trace, and closing the scope quiescent. A negative
 * probe proves that importing a name the kit has never exported still
 * fails to compile, and (local mode only) the packed tarball is asserted to
 * actually contain `dist/test/index.js`, `dist/test/index.cjs`, and
 * `dist/test/index.d.ts`, so a build-configuration regression that stops
 * emitting the test subpath fails here rather than at a consumer's install.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

import { readPendingChangesets } from './check-changesets';

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

/**
 * Runs a command and returns its exit code, stdout, and combined output
 * without throwing. `output` (stdout+stderr) is for error diagnostics only —
 * a caller that parses a successful command's stdout as JSON must use
 * `stdout` alone, since an ordinary npm warning on stderr would otherwise
 * corrupt the payload the way concatenating stdout+stderr does for
 * {@link runForStdout}'s callers.
 */
async function runExpectingFailure(
  command: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; output: string }> {
  const [executable, ...arguments_] = command;
  const result = await $`${executable} ${arguments_}`.cwd(cwd).nothrow().quiet();
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    output: `${result.stdout}${result.stderr}`,
  };
}

/** Packs the package at `directory` with `npm pack --ignore-scripts` and returns the tarball's absolute path. */
async function packDirectory(directory: string, staging: string): Promise<string> {
  const stdout = await runForStdout(
    ['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', staging],
    directory,
  );
  const filename = (JSON.parse(stdout) as Array<{ filename: string }>)[0]?.filename;
  if (!filename) throw new Error(`npm pack produced no tarball for ${directory}`);
  return join(staging, filename);
}

async function packLocal(staging: string): Promise<string> {
  return packDirectory(packageDirectory, staging);
}

// ---------------------------------------------------------------------------
// AB-287: workspace-sibling detection for local mode.
// ---------------------------------------------------------------------------

type PackageManifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};

async function readPackageManifest(directory: string): Promise<PackageManifest> {
  return (await Bun.file(join(directory, 'package.json')).json()) as PackageManifest;
}

/** Every `packages/*` workspace manifest, keyed by its `name` field. */
async function readWorkspaceManifestsByName(): Promise<
  Map<string, { directory: string; manifest: PackageManifest }>
> {
  const byName = new Map<string, { directory: string; manifest: PackageManifest }>();
  const glob = new Bun.Glob('packages/*/package.json');
  for await (const manifestPath of glob.scan({ cwd: root, onlyFiles: true })) {
    const directory = join(root, manifestPath, '..');
    const manifest = await readPackageManifest(directory);
    byName.set(manifest.name, { directory, manifest });
  }
  return byName;
}

/**
 * Operative's own `dependencies` entries that resolve to another package IN
 * this monorepo (matched on the dependency's NAME against every
 * `packages/*` manifest's `name` field, not on directory name — a scoped
 * sibling stays correctly matched either way). `@lostgradient/weft` is an
 * external dependency (its own separate repository, per CLAUDE.md) and is
 * never a workspace sibling here, even though it is scoped like operative
 * itself.
 */
async function findWorkspaceSiblings(): Promise<
  Array<{ name: string; directory: string; version: string }>
> {
  const operativeManifest = await readPackageManifest(packageDirectory);
  const workspaceManifests = await readWorkspaceManifestsByName();
  const siblings: Array<{ name: string; directory: string; version: string }> = [];
  for (const dependencyName of Object.keys(operativeManifest.dependencies ?? {})) {
    const workspacePackage = workspaceManifests.get(dependencyName);
    if (!workspacePackage) continue;
    siblings.push({
      name: dependencyName,
      directory: workspacePackage.directory,
      version: workspacePackage.manifest.version,
    });
  }
  return siblings;
}

/**
 * The exact versions `npm view <name> versions --json` reports as published.
 * `npm view` prints a bare JSON string (not an array) when exactly one
 * version is published, and exits non-zero with an E404 when the package has
 * never been published at all — both are normalized here rather than left
 * for the caller to special-case.
 */
async function getRegistryVersions(name: string): Promise<string[]> {
  const result = await runExpectingFailure(['npm', 'view', name, 'versions', '--json'], root);
  if (result.exitCode !== 0) {
    if (/E404/.test(result.output)) return [];
    throw new Error(`npm view ${name} versions failed:\n${result.output}`);
  }
  const parsed = JSON.parse(result.stdout) as string | string[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

type SiblingPackReason = 'not-on-registry' | 'pending-changeset' | 'forced';

type SiblingDecision = {
  name: string;
  directory: string;
  version: string;
  pack: boolean;
  reason: SiblingPackReason | 'registry';
};

/**
 * Pure decision function (no I/O) — pack a workspace sibling when its exact
 * workspace version is not among the registry's published versions, when a
 * pending changeset targets it (a changeset can bump a version identical to
 * what is already published, which the version check alone cannot see — the
 * conversationalist@1.1.0 case this issue exists for), or when forced.
 */
export function decideSiblingPacking(
  siblings: readonly { name: string; directory: string; version: string }[],
  registryVersionsByName: ReadonlyMap<string, readonly string[]>,
  changesetTargetNames: ReadonlySet<string>,
  forcePackAll: boolean,
): SiblingDecision[] {
  return siblings.map((sibling) => {
    if (forcePackAll) return { ...sibling, pack: true, reason: 'forced' };
    const registryVersions = registryVersionsByName.get(sibling.name) ?? [];
    if (!registryVersions.includes(sibling.version)) {
      return { ...sibling, pack: true, reason: 'not-on-registry' };
    }
    if (changesetTargetNames.has(sibling.name)) {
      return { ...sibling, pack: true, reason: 'pending-changeset' };
    }
    return { ...sibling, pack: false, reason: 'registry' };
  });
}

async function resolveSiblingDecisions(forcePackAll: boolean): Promise<SiblingDecision[]> {
  const siblings = await findWorkspaceSiblings();
  const changesets = await readPendingChangesets(root);
  const changesetTargetNames = new Set(
    changesets.flatMap((changeset) => changeset.releases.map((release) => release.name)),
  );
  const registryVersionsByName = new Map<string, readonly string[]>(
    await Promise.all(
      siblings.map(async (sibling): Promise<[string, readonly string[]]> => [
        sibling.name,
        forcePackAll ? [] : await getRegistryVersions(sibling.name),
      ]),
    ),
  );
  return decideSiblingPacking(siblings, registryVersionsByName, changesetTargetNames, forcePackAll);
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

// Exercises the Agent generation profile surface (AB-64, AB-245):
// createModelCatalog (subpath export, mirroring getProviderCapabilities),
// withBackendDescriptors/readBackendDescriptors, and readGenerationProfile —
// on a real packed tarball, not just the workspace source.
const MODEL_CAPABILITY_DEFINITION = `import { createAgent, readGenerationProfile } from '@lostgradient/operative';
import type { GenerateFunction } from '@lostgradient/operative';
import {
  createModelCatalog,
  readBackendDescriptors,
  withBackendDescriptors,
} from '@lostgradient/operative/providers';

import { makeDeterministicGenerate } from './generate';
import { makeToolbox } from './tools';

export function buildCatalog() {
  return createModelCatalog({ now: () => '2026-01-01T00:00:00.000Z' });
}

export function opaqueAgentProfile() {
  const agent = createAgent({ generate: makeDeterministicGenerate(), toolbox: makeToolbox() });
  return readGenerationProfile(agent);
}

export function fixedAgentProfile() {
  const catalog = buildCatalog();
  const descriptor = catalog.descriptors.find((row) => row.provider === 'anthropic');
  if (!descriptor) {
    throw new Error('expected at least one anthropic descriptor in the seed catalog');
  }
  const generate: GenerateFunction = withBackendDescriptors(makeDeterministicGenerate(), [
    descriptor,
  ]);
  const agent = createAgent({ generate, toolbox: makeToolbox() });
  return {
    profile: readGenerationProfile(agent),
    descriptorsOnGenerate: readBackendDescriptors(generate),
  };
}
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
  'removed-bureau-types.ts': `// The subpath itself is removed, but importing an ARBITRARY (nonexistent)
// name from it would fail even if the subpath were restored — that's not a
// real regression signal. Import one of its actual former exports so this
// probe only "passes" (stays broken) when the real subpath is truly gone,
// not merely because 'Anything' never existed there.
import type { AgentRun } from '@lostgradient/operative/bureau-types';

export type Probe = AgentRun;
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

// AB-259: an executed probe of `@lostgradient/operative/test` — the test
// kit AB-92/AB-252/255/256/257/258 built. Every value export the issue
// names is genuinely called (not merely imported): `createManualRuntimeServices`,
// `createEventRecorder`, `createResourceScope`, `createScriptedGenerate`,
// and `createScriptedTool` drive one real agent run to completion through a
// `ResourceScope`, whose normalized causal trace and quiescent close are
// then asserted; `createScriptedHook` is constructed and inspected on its
// own (`createAgent`'s public options accept no `hooks` field — hooks
// compose on the toolbox instead — so there is nothing to wire it into);
// `runReactiveSourceConformanceSuite` registers and runs its real
// `describe`/`it` cases against a minimal, genuinely conforming in-memory
// subject. `FaultPlan`/`FaultPlanEntry`/`FiredFault` are compile-time-only
// checks against real literal shapes — AB-95's fault engine does not exist
// yet, so nothing here fires a fault.
const KIT_PROBE_MODULE = `import { createAgent } from '@lostgradient/operative';
import { noToolCalls } from '@lostgradient/operative/conditions';
import type {
  CausalTraceEntry,
  FaultPlan,
  FaultPlanEntry,
  FiredFault,
  LeakedResource,
  ManualRuntimeServices,
  QuiescenceReport,
  ReactiveSourceSubject,
} from '@lostgradient/operative/test';
import {
  createEventRecorder,
  createManualRuntimeServices,
  createResourceScope,
  createScriptedGenerate,
  createScriptedHook,
  createScriptedTool,
  runReactiveSourceConformanceSuite,
} from '@lostgradient/operative/test';
import { createToolbox } from 'armorer';

// ---------------------------------------------------------------------------
// FaultPlan / FaultPlanEntry / FiredFault — compile-time-only type-checks
// against a real literal shape.
// ---------------------------------------------------------------------------
const kitProbeFaultPlanEntry: FaultPlanEntry = {
  id: 'probe-fault',
  boundary: 'before-work',
  operation: 'generate',
  occurrence: { kind: 'nth', n: 1 },
  effect: undefined,
};
export const kitProbeFaultPlan: FaultPlan = [kitProbeFaultPlanEntry];
export const kitProbeFiredFault: FiredFault = {
  plan: 'probe-fault',
  boundary: 'before-work',
  occurrence: 1,
  firedAt: '2026-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// createScriptedHook — constructed and inspected for real.
// ---------------------------------------------------------------------------
export function buildProbeHook() {
  const hook = createScriptedHook('after-tool', [{ kind: 'resolve', value: undefined }]);
  if (hook.hookName !== 'afterToolExecution') {
    throw new Error(\`kit probe: unexpected hookName \${hook.hookName}\`);
  }
  return hook;
}

// ---------------------------------------------------------------------------
// runReactiveSourceConformanceSuite — a minimal, genuinely conforming
// in-memory counter subject, registered through the real suite.
// ---------------------------------------------------------------------------
interface CounterSnapshot {
  readonly value: number;
}

interface CounterSubject extends ReactiveSourceSubject<CounterSnapshot> {
  applyChange(): Promise<void>;
}

function createCounterSubject(runtime: ManualRuntimeServices): CounterSubject {
  let current: CounterSnapshot = { value: 0 };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribeSnapshot(invalidate) {
      listeners.add(invalidate);
      return () => {
        listeners.delete(invalidate);
      };
    },
    async applyChange() {
      await new Promise<void>((resolve) => {
        runtime.timers.setTimeout(() => {
          current = { value: current.value + 1 };
          for (const listener of listeners) listener();
          resolve();
        }, 5);
      });
    },
  };
}

function createTerminalCounterSubject(): ReactiveSourceSubject<CounterSnapshot> {
  const terminal: CounterSnapshot = { value: 99 };
  return {
    getSnapshot: () => terminal,
    subscribeSnapshot: () => () => {},
  };
}

export function registerKitProbeReactiveSuite(runtime: ManualRuntimeServices): void {
  runReactiveSourceConformanceSuite({
    label: 'kit probe in-memory counter',
    createSubject: () => createCounterSubject(runtime),
    async triggerChange(subject: CounterSubject) {
      const done = subject.applyChange();
      // Yield once before driving the virtual clock so a mid-flight read
      // genuinely observes the "started, not yet committed" window.
      await Promise.resolve();
      await runtime.advance(50);
      await done;
    },
    createAlreadyTerminalSubject: createTerminalCounterSubject,
  });
}

// ---------------------------------------------------------------------------
// The executed scenario the issue's acceptance criteria names directly: a
// manual runtime, a scripted generate and scripted tool, one run driven to
// completion through a resource scope, the recorded normalized trace
// asserted, and the scope closed quiescent.
// ---------------------------------------------------------------------------
export interface KitProbeOutcome {
  readonly trace: readonly CausalTraceEntry[];
  readonly report: QuiescenceReport;
}

export async function runKitProbe(): Promise<KitProbeOutcome> {
  const runtime = createManualRuntimeServices();
  const recorder = createEventRecorder(runtime);
  const scope = createResourceScope('kit-probe', runtime);

  const tool = createScriptedTool('echo', [{ kind: 'resolve', result: { echoed: 'hi, hi' } }]);
  const toolbox = createToolbox([tool]);

  const generate = createScriptedGenerate([
    {
      kind: 'respond',
      response: { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'hi' } }] },
    },
    { kind: 'respond', response: { content: 'done', toolCalls: [] } },
  ]);

  const agent = createAgent({
    name: 'kit-probe-agent',
    generate,
    toolbox,
    runtime,
    // A step-count predicate (like the other fixtures in this file use)
    // would need a THIRD scripted step to observe it: the run layer checks
    // the stop condition against the step just completed, so a two-response
    // script stopping cleanly needs the real "no tool calls left" condition
    // instead of counting steps.
    stopWhen: noToolCalls(),
  });

  const run = agent.run('Say hello.');
  recorder.attachIterable(run, { kind: 'agent-run', id: 'kit-probe-run' });
  scope.register({ kind: 'run', identifier: 'kit-probe-run', run });

  const result = await run.result();
  // \`result()\` resolving doesn't guarantee attachIterable's background
  // consumption loop has caught up to the iterable's own end.
  await runtime.deferred.drain();

  if (result.finishReason !== 'stop-condition') {
    throw new Error(\`kit probe: unexpected finishReason \${result.finishReason}\`);
  }
  if (tool.callCount !== 1) {
    throw new Error(\`kit probe: expected the scripted tool to be called once, got \${tool.callCount}\`);
  }

  const trace = recorder.normalize();
  const traceEvents = trace.map((entry) => entry.event);
  if (trace.length === 0 || !traceEvents.includes('run.completed')) {
    throw new Error(
      \`kit probe: normalized trace never recorded run.completed: [\${traceEvents.join(', ')}]\`,
    );
  }

  const report = await scope.close();
  if (!report.quiescent) {
    const leaked: readonly LeakedResource[] = report.leaked;
    throw new Error(\`kit probe: resource scope not quiescent after close(): \${JSON.stringify(leaked)}\`);
  }

  return { trace, report };
}
`;

const KIT_PROBE_TEST = `import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from '@lostgradient/operative/test';

import { buildProbeHook, registerKitProbeReactiveSuite, runKitProbe } from '../src/kit-probe';

describe('operative test-kit probe (AB-259)', () => {
  it('drives a real agent run through a resource scope and records a non-empty causal trace', async () => {
    const { trace, report } = await runKitProbe();

    expect(trace.length).toBeGreaterThan(0);
    expect(trace.map((entry) => entry.event)).toContain('run.completed');
    expect(report.quiescent).toBe(true);
    expect(report.leaked).toEqual([]);
  });

  it('constructs a scripted hook double for the after-tool phase', () => {
    const hook = buildProbeHook();

    expect(hook.hookName).toBe('afterToolExecution');
    expect(hook.callCount).toBe(0);
  });
});

registerKitProbeReactiveSuite(createManualRuntimeServices());
`;

// AB-259: a negative probe naming an export the kit has never had. Kept
// separate from REMOVED_API_PROBES (which proves a REMOVED name stays
// removed) — this proves a NEVER-EXISTED name stays rejected, so a future
// kit rename that silently drops or renames a real export cannot pass this
// verifier by accident. Written outside \`src/\`/\`test/\` (a top-level
// \`kit-negative/\` directory, exactly like \`removed/\`) so it is excluded
// from the whole-project \`tsc --noEmit\` and checked individually instead.
const KIT_EXPORT_NEGATIVE_PROBES: Record<string, string> = {
  'kit-nonexistent-export.ts': `// This name has never existed on the @lostgradient/operative/test kit. If
// this ever compiles, the negative probe has gone vacuous — a future kit
// rename could then silently pass verification. See AB-259.
import { createOperativeTestKitExportThatDoesNotExist } from '@lostgradient/operative/test';

export { createOperativeTestKitExportThatDoesNotExist };
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
  // unwrap() is also typed as Promise<GreetingOutput> — the SAME parsed
  // value — for a schema-backed (H = true) run, not Promise<string>.
  const unwrapped: GreetingOutput = await run.unwrap();
  const result = await run.result();
  if (result.output !== undefined) {
    const inferred: GreetingOutput = result.output;
    void inferred;
  }
  void output;
  void unwrapped;
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
  // unwrap() DOES still exist for an untyped (H = false) run, but typed as
  // Promise<string> (the raw final text) — never the parsed-object type.
  const unwrapped: string = await run.unwrap();
  const result = await run.result();
  void result;
  void unwrapped;
}

void typedOutputAccessor;
void untypedNoOutputAccessor;
`;

const SMOKE_TEST = `import {
  AgentContractError,
  AsyncDefinitionLoadError,
  createAgent,
  parseRunFrame,
  UnsupportedRunResultLegacyFieldError,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { barrelAgent } from '../src/barrel';
import { directAgent } from '../src/direct';
import { literalDynamicImportAgent } from '../src/dynamic-literal';
import { makeDeterministicGenerate } from '../src/generate';
import { runInlineAgent } from '../src/inline';
import { lazyAgent } from '../src/lazy-agent';
import { agentWithLazyGenerate } from '../src/lazy-generate';
import {
  buildCatalog,
  fixedAgentProfile,
  opaqueAgentProfile,
} from '../src/model-capability';
import { makeToolbox } from '../src/tools';
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

describe('unwrap() return-type contract', () => {
  it('resolves the parsed, schema-validated object for a schema-backed (H = true) run', async () => {
    const unwrapped = await directAgent().run('Say hello.').unwrap();
    expect(unwrapped).toEqual({ greeting: 'hello, hello' });
  });

  it('resolves the raw final text (never a parsed object) for a schema-less (H = false) run', async () => {
    const untyped = createAgent({
      generate: makeDeterministicGenerate(),
      toolbox: makeToolbox(),
    });
    const unwrapped = await untyped.run('Say hello.').unwrap();
    expect(typeof unwrapped).toBe('string');
    expect(unwrapped).toBe(JSON.stringify({ greeting: 'hello, hello' }));
  });
});

describe('model catalog and Agent generation profile (AB-64, AB-245)', () => {
  it('builds a frozen, privileged-projection model catalog seed from the packed tarball', () => {
    const catalog = buildCatalog();
    expect(catalog.projection).toBe('privileged');
    expect(catalog.revision).toBe(1);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.descriptors)).toBe(true);
    expect(catalog.descriptors.length).toBeGreaterThan(0);
  });

  it('reports an opaque generation profile for a standalone agent with no attached descriptors', () => {
    const profile = opaqueAgentProfile();
    expect(profile.mode).toBe('opaque');
    expect(profile.descriptors).toEqual([]);
    expect(profile.selector).toBe('unavailable');
  });

  it('reports a fixed generation profile once a descriptor is attached to the GenerateFunction', () => {
    const { profile, descriptorsOnGenerate } = fixedAgentProfile();
    expect(profile.mode).toBe('fixed');
    expect(profile.descriptors).toHaveLength(1);
    expect(descriptorsOnGenerate).toHaveLength(1);
    expect(profile.descriptors[0]).toEqual(descriptorsOnGenerate[0]);
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
  await Bun.write(join(directory, 'src', 'model-capability.ts'), MODEL_CAPABILITY_DEFINITION);
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
  await Bun.write(join(directory, 'src', 'kit-probe.ts'), KIT_PROBE_MODULE);
  await Bun.write(join(directory, 'test', 'kit-probe.test.ts'), KIT_PROBE_TEST);
  for (const [filename, content] of Object.entries(REMOVED_API_PROBES)) {
    await Bun.write(join(directory, 'removed', filename), content);
  }
  for (const [filename, content] of Object.entries(KIT_EXPORT_NEGATIVE_PROBES)) {
    await Bun.write(join(directory, 'kit-negative', filename), content);
  }
}

/** Bare-package deps every consumer file needs, declared directly rather than left phantom. */
const CONSUMER_DEPENDENCY_RANGES = {
  armorer: '^2.3.0',
  conversationalist: '^1.1.0',
  zod: '^4.4.3',
};

async function writeConsumerManifest(
  directory: string,
  operativeSpecifier: string,
  siblingSpecifiers: Readonly<Record<string, string>>,
): Promise<void> {
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
          ...siblingSpecifiers,
        },
        devDependencies: { typescript: '6.0.3', '@types/bun': '1.3.14' },
        // The packed `@lostgradient/operative` tarball's OWN manifest still
        // declares a plain semver range for each packed sibling (e.g.
        // `"conversationalist": "^1.1.0"`) — a range a REGISTRY-resolved
        // 1.1.0 also satisfies. Without an override, Bun resolves that
        // nested reference independently of the direct dependency above and
        // installs it from the registry as a separate, importer-prefixed
        // entry (`"@lostgradient/operative/conversationalist"`), silently
        // defeating the whole point of packing it. `overrides` forces every
        // transitive reference to a packed sibling's name onto its own
        // local tarball, matching `verify-bureau-tarball-boundary.ts`'s
        // established pattern for the identical problem.
        ...(Object.keys(siblingSpecifiers).length > 0 ? { overrides: siblingSpecifiers } : {}),
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
 * mode); EVERY resolved occurrence of a packed workspace sibling (AB-287) —
 * including a nested, importer-prefixed key Bun did not dedupe onto the
 * top-level entry — resolves to that sibling's own tarball path; and every
 * OTHER resolved package carries a plain semver version with no
 * `workspace:`, `link:`, `patch:`, or local filesystem path.
 */
async function verifyLockfile(
  directory: string,
  mode: 'local' | 'registry',
  expected: { tarball?: string; version?: string },
  packedSiblings: ReadonlyMap<string, string>,
): Promise<void> {
  const lockText = await Bun.file(join(directory, 'bun.lock')).text();
  const packagesStart = lockText.indexOf('"packages": {');
  if (packagesStart === -1) throw new Error('bun.lock has no "packages" block');
  const lines = lockText
    .slice(packagesStart)
    .split('\n')
    .filter((line) => /^\s*"[^"]+":\s*\[/.test(line));

  let sawOperative = false;
  const sawPackedSibling = new Set<string>();
  for (const line of lines) {
    // The lock KEY (`"<key>": [...`) is not always the resolved package's
    // own name — a transitive dependency Bun could not dedupe gets an
    // importer-prefixed key like `"ajv-formats/ajv"`, while the tuple's
    // FIRST string is still the real resolved identity, e.g. `"ajv@8.18.0"`.
    // Building an exact-name regex from the key (rather than parsing that
    // first tuple string) misses every such nested entry. Parse the tuple
    // itself: the first quoted string right after the opening `[`.
    const tupleMatch = /:\s*\[\s*"([^"]+)"/.exec(line);
    const resolvedEntry = tupleMatch?.[1];
    if (!resolvedEntry)
      throw new Error(`Could not parse a resolved entry from bun.lock line: ${line}`);
    // Split "<name>@<version-or-path>" into name/version, accounting for a
    // scoped name's own leading "@" (e.g. "@lostgradient/operative@0.10.0").
    const entryMatch = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(resolvedEntry);
    if (!entryMatch)
      throw new Error(`Could not split resolved entry "${resolvedEntry}" in bun.lock`);
    const [, resolvedName, resolvedVersion] = entryMatch;

    if (resolvedName === '@lostgradient/operative') {
      sawOperative = true;
      if (mode === 'local') {
        if (!expected.tarball || resolvedVersion !== expected.tarball) {
          throw new Error(
            `@lostgradient/operative did not resolve to the local tarball ${expected.tarball}:\n${line}`,
          );
        }
      } else {
        if (!expected.version || resolvedVersion !== expected.version) {
          throw new Error(
            `@lostgradient/operative did not resolve to registry version ${expected.version}:\n${line}`,
          );
        }
      }
      continue;
    }

    const packedTarball = resolvedName ? packedSiblings.get(resolvedName) : undefined;
    if (resolvedName && packedTarball !== undefined) {
      if (resolvedVersion !== packedTarball) {
        throw new Error(
          `Packed workspace sibling ${resolvedName} did not resolve to its tarball ${packedTarball} at every occurrence:\n${line}`,
        );
      }
      sawPackedSibling.add(resolvedName);
      continue;
    }

    // Positively assert a plain registry semver rather than blacklisting
    // known non-registry substrings: a local tarball/directory resolution
    // outside the repository root (`name@/tmp/dependency.tgz`, an absolute
    // path with no `file:`/`workspace:`/`link:`/`patch:` prefix at all —
    // see verify-bureau-tarball-boundary.ts's own doc comment on this exact
    // lockfile shape) would pass a substring blacklist while still being
    // exactly the non-registry resolution this check exists to reject.
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(resolvedVersion ?? '')) {
      throw new Error(
        `${resolvedName} did not resolve to a plain registry semver in bun.lock (got "${resolvedVersion}"):\n${line}`,
      );
    }
  }
  if (!sawOperative) throw new Error('bun.lock never resolved @lostgradient/operative at all');
  for (const [name, tarball] of packedSiblings) {
    if (!sawPackedSibling.has(name)) {
      throw new Error(`bun.lock never resolved packed workspace sibling ${name} to ${tarball}`);
    }
  }
}

/**
 * Checks every probe file in `subdirectory` (relative to `directory`)
 * individually with its own `tsc` invocation, asserting each one FAILS to
 * compile — used for both `REMOVED_API_PROBES` (a removed name must stay
 * removed) and `KIT_EXPORT_NEGATIVE_PROBES` (a name the kit never had must
 * stay rejected, so a future rename cannot silently pass verification).
 */
async function verifyProbesFailCompilation(
  directory: string,
  subdirectory: string,
  probes: Readonly<Record<string, string>>,
): Promise<void> {
  for (const filename of Object.keys(probes)) {
    const relativePath = join(subdirectory, filename);
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
        // TypeScript 6's TS5112 refuses to run at all when a file is named
        // on the command line inside a directory that also has a
        // tsconfig.json, unless told to ignore it — without this flag every
        // per-file probe invocation below "fails" on that config error
        // regardless of whether the probe's own removed/nonexistent import
        // would genuinely fail to compile, making the whole check vacuous.
        '--ignoreConfig',
        relativePath,
      ],
      directory,
    );
    if (result.exitCode === 0) {
      throw new Error(
        `Probe ${relativePath} unexpectedly compiled — the surface it targets still exists:\n${result.output}`,
      );
    }
  }
}

/**
 * AB-259: the executed kit probe (`src/kit-probe.ts`) type-checks on its
 * own, with its own `tsc` invocation — the same pattern the removed-API and
 * kit-negative probes use, but asserting SUCCESS instead of failure.
 */
async function verifyKitProbeTypeChecksStandalone(directory: string): Promise<void> {
  const relativePath = join('src', 'kit-probe.ts');
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
      // See the matching comment in `verifyProbesFailCompilation` — without
      // this, TS5112 fails the invocation before the file is even checked.
      '--ignoreConfig',
      relativePath,
    ],
    directory,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Kit probe ${relativePath} failed to type-check on its own:\n${result.output}`);
  }
}

/**
 * AB-259: asserts a packed `@lostgradient/operative` tarball actually
 * contains the `./test` subpath's build output — so a build-configuration
 * regression that stops emitting it fails here, at verification time,
 * rather than surfacing only at a real consumer's install.
 */
async function verifyTarballContainsTestSubpath(tarball: string): Promise<void> {
  const requiredEntries = [
    'package/dist/test/index.js',
    'package/dist/test/index.cjs',
    'package/dist/test/index.d.ts',
  ];
  const stdout = await runForStdout(['tar', '-tzf', tarball], root);
  const entries = new Set(
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const missing = requiredEntries.filter((entry) => !entries.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `Packed @lostgradient/operative tarball is missing the ./test subpath's build output: ${missing.join(', ')}`,
    );
  }
}

async function verifyConsumer(
  directory: string,
  mode: 'local' | 'registry',
  operativeSpecifier: string,
  expected: { tarball?: string; version?: string },
  siblingSpecifiers: Readonly<Record<string, string>> = {},
  packedSiblings: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  await writeConsumerManifest(directory, operativeSpecifier, siblingSpecifiers);
  await writeConsumerSource(directory);

  // Produces bun.lock — a fresh consumer has none yet.
  await run(['bun', 'install'], directory);
  // The reproducibility assertion the issue names explicitly.
  await run(['bun', 'install', '--frozen-lockfile'], directory);
  await verifyLockfile(directory, mode, expected, packedSiblings);

  await run(['bunx', 'tsc', '--noEmit'], directory);
  await verifyKitProbeTypeChecksStandalone(directory);
  await run(['bun', 'test'], directory);
  await verifyProbesFailCompilation(directory, 'removed', REMOVED_API_PROBES);
  await verifyProbesFailCompilation(directory, 'kit-negative', KIT_EXPORT_NEGATIVE_PROBES);
}

async function main(): Promise<void> {
  const modeIndex = Bun.argv.indexOf('--mode');
  const mode = modeIndex !== -1 ? Bun.argv[modeIndex + 1] : undefined;
  if (mode !== 'local' && mode !== 'registry') {
    throw new Error(
      'Usage: bun run scripts/verify-operative-consumer.ts --mode local [--pack-siblings]\n' +
        '       bun run scripts/verify-operative-consumer.ts --mode registry --version <version>',
    );
  }

  if (mode === 'local') {
    const forcePackSiblings = Bun.argv.includes('--pack-siblings');

    // Building operative (`^build`) already builds every workspace sibling
    // it depends on, so a packed sibling's own `dist/` is guaranteed fresh
    // by the time it is packed below — no separate build step needed.
    await run(['turbo', 'run', 'build', '--filter=@lostgradient/operative'], root);
    await run(['bun', 'run', 'scripts/check-package-shape.ts', 'operative'], root);

    const siblingDecisions = await resolveSiblingDecisions(forcePackSiblings);

    const staging = await mkdtemp(join(tmpdir(), 'operative-consumer-pack-'));
    const directory = await mkdtemp(join(tmpdir(), 'operative-consumer-local-'));
    try {
      const tarball = await packLocal(staging);
      await verifyTarballContainsTestSubpath(tarball);

      const siblingSpecifiers: Record<string, string> = {};
      const packedSiblings = new Map<string, string>();
      for (const decision of siblingDecisions) {
        if (!decision.pack) continue;
        const siblingTarball = await packDirectory(decision.directory, staging);
        siblingSpecifiers[decision.name] = `file:${siblingTarball}`;
        packedSiblings.set(decision.name, siblingTarball);
      }

      await verifyConsumer(
        directory,
        'local',
        `file:${tarball}`,
        { tarball },
        siblingSpecifiers,
        packedSiblings,
      );

      const packedSummary =
        packedSiblings.size === 0
          ? 'no workspace siblings packed (every sibling resolves from the registry)'
          : `packed workspace siblings: ${siblingDecisions
              .filter((decision) => decision.pack)
              .map((decision) => `${decision.name}@${decision.version} (${decision.reason})`)
              .join(', ')}`;
      console.log(
        'Operative consumer verification (local) passed: tarball (including the ./test ' +
          'subpath build output), lockfile boundary, direct/inline/barrel/dynamic-import/lazy ' +
          'definitions, output inference, widened-module runtime guards, the executed ' +
          '@lostgradient/operative/test kit probe, and removed-API/kit-negative compile ' +
          `failures. AB-287: ${packedSummary}.`,
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

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
