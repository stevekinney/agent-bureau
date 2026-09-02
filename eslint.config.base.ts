import { fixupPluginRules } from '@eslint/compat';
import js from '@eslint/js';
import type { Linter, Rule } from 'eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintComments from 'eslint-plugin-eslint-comments';
import importPlugin from 'eslint-plugin-import';
import promise from 'eslint-plugin-promise';
import regexp from 'eslint-plugin-regexp';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unicorn from 'eslint-plugin-unicorn';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import rawDeterminismManifest from './scripts/determinism-manifest.json' with { type: 'json' };

const commonFiles = '**/*.{js,jsx,cjs,mjs,ts,tsx}';

export const testFiles = [
  '**/*.{test,spec,e2e,bench}.{js,jsx,ts,tsx}',
  '**/test/**/*.{js,jsx,ts,tsx}',
  '**/tests/**/*.{js,jsx,ts,tsx}',
  '**/__tests__/**/*.{js,jsx,ts,tsx}',
];

const commonPlugins = {
  promise: fixupPluginRules(promise),
  unicorn: fixupPluginRules(unicorn),
  import: fixupPluginRules(importPlugin),
  'eslint-comments': fixupPluginRules(eslintComments),
  regexp: fixupPluginRules(regexp),
  'unused-imports': fixupPluginRules(unusedImports),
  'simple-import-sort': fixupPluginRules(simpleImportSort),
};

const coreRules: Linter.RulesRecord = {
  'no-restricted-syntax': ['error', 'WithStatement', 'LabeledStatement'],
  'no-console': 'off',
};

const promiseRules: Linter.RulesRecord = {
  'promise/no-return-wrap': 'error',
  'promise/param-names': 'error',
  'promise/catch-or-return': 'error',
  'promise/no-nesting': 'warn',
  'promise/no-promise-in-callback': 'warn',
  'promise/no-callback-in-promise': 'warn',
  'promise/no-new-statics': 'error',
  'promise/no-return-in-finally': 'warn',
  'promise/valid-params': 'warn',
};

const unicornRules: Linter.RulesRecord = {
  'unicorn/prevent-abbreviations': 'off',
  'unicorn/no-null': 'off',
  'unicorn/prefer-switch': 'warn',
  'unicorn/prefer-logical-operator-over-ternary': 'warn',
  'unicorn/no-await-expression-member': 'error',
};

const importRules: Linter.RulesRecord = {
  'import/no-extraneous-dependencies': 'off',
  'import/order': 'off',
  'import/first': 'error',
  'import/no-duplicates': 'error',
  'import/no-cycle': 'error',
  'unused-imports/no-unused-imports': 'error',
  'simple-import-sort/imports': 'error',
  'simple-import-sort/exports': 'error',
};

const eslintCommentsRules: Linter.RulesRecord = {
  'eslint-comments/disable-enable-pair': 'error',
  'eslint-comments/no-unlimited-disable': 'error',
  'eslint-comments/no-unused-disable': 'error',
};

const regexpRules: Linter.RulesRecord = {
  'regexp/no-empty-capturing-group': 'error',
  'regexp/no-lazy-ends': 'error',
};

/**
 * Determinism gate (AB-278): rejects direct use of real clocks, timers, and identifier/random
 * sources inside `scripts/determinism-manifest.json`'s `deterministicDirectories`, and rejects
 * process-global transport mutation (`(globalThis|global).(fetch|WebSocket|EventSource) = ...`)
 * anywhere under `packages/`. Both rules are manifest-driven: a path listed under the manifest's
 * `realRuntimeExemptions` is skipped instead of flagged.
 *
 * The rule implementations live here so `eslint.config.base.ts` — spread into every package's
 * `eslint.config.js` — enforces them through the ordinary `turbo run lint` path. The *inline
 * eslint-disable-comment bypass* guarantee (a `// eslint-disable-next-line` above an offending
 * call must not suppress the report) is NOT provided by this per-package integration: ESLint's
 * `linterOptions.noInlineConfig` is scoped per matched file, not per rule, and the
 * transport-mutation rule is deliberately repo-wide, so making it non-bypassable here would mean
 * disabling ALL inline disable comments across the entire `packages/` tree — collateral damage to
 * every other rule's legitimate disables. `scripts/check-determinism.ts` re-runs these same two
 * rules through `Linter.verify` in an isolated config where NO other rule is registered, so
 * `noInlineConfig: true` there affects only these two rules — this is where the non-bypass
 * guarantee actually lives, and it is wired into `bun run validate` directly (see
 * `scripts/check-determinism.ts` for the rationale in full).
 */

export interface DeterminismManifestExemption {
  readonly path: string;
  readonly reason: string;
  readonly owner: string;
  readonly owningIssue: string;
}

export interface DeterminismManifest {
  readonly deterministicDirectories: readonly string[];
  readonly realRuntimeExemptions: readonly DeterminismManifestExemption[];
}

const DETERMINISM_ACTION_SENTENCE =
  'Drive an injected RuntimeServices instead, or add this path to scripts/determinism-manifest.json with a reason and an owning issue.';

/** The transport-mutation rule's scope: every file under `packages/`, exemptions aside. */
const TRANSPORT_MUTATION_SCOPE_GLOB = 'packages/**';

const GLOBSTAR_PLACEHOLDER = '\u0000';

/** Converts a `*`/`**`-only glob into an anchored RegExp matched against a POSIX-relative path. */
function globToRegExp(glob: string): RegExp {
  const segments = glob.split('/').map((segment) => {
    if (segment === '**') return GLOBSTAR_PLACEHOLDER;
    const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return escaped.replace(/\*/g, '[^/]*');
  });

  const pattern = segments
    .join('/')
    .replace(new RegExp(`/${GLOBSTAR_PLACEHOLDER}/`, 'g'), '/(?:.*/)?')
    .replace(new RegExp(`^${GLOBSTAR_PLACEHOLDER}/`), '(?:.*/)?')
    .replace(new RegExp(`/${GLOBSTAR_PLACEHOLDER}$`), '(?:/.*)?')
    .replace(new RegExp(`^${GLOBSTAR_PLACEHOLDER}$`), '.*');

  return new RegExp(`^${pattern}$`);
}

export function matchesAnyGlob(relativePath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(relativePath));
}

/**
 * Resolves an ESLint rule's `context.filename` (absolute when linting real files under a
 * package's own `eslint .` invocation, or already repo-relative when a test passes a synthetic
 * filename straight to `Linter.verify`) to a POSIX path relative to the repository root.
 */
export function toRepoRelativePosixPath(filename: string, repoRoot: string): string {
  // Normalize separators BEFORE the prefix comparison, not after: a Windows filename like
  // `C:\repo\packages\...` compared against a POSIX-converted `C:\repo/` (mixed separators)
  // never matches the prefix, and the caller's later separator conversion happens too late to
  // fix it. Converting both operands up front keeps the comparison — and everything after it —
  // separator-agnostic.
  const posixFilename = filename.split('\\').join('/');
  const posixRepoRoot = repoRoot.split('\\').join('/');
  const normalizedRoot = posixRepoRoot.endsWith('/') ? posixRepoRoot : `${posixRepoRoot}/`;
  return posixFilename.startsWith(normalizedRoot)
    ? posixFilename.slice(normalizedRoot.length)
    : posixFilename;
}

function exemptionGlobs(manifest: DeterminismManifest): string[] {
  return manifest.realRuntimeExemptions.map((exemption) => exemption.path);
}

function isDeterministicDirectoryFile(
  relativePath: string,
  manifest: DeterminismManifest,
): boolean {
  return (
    matchesAnyGlob(relativePath, manifest.deterministicDirectories) &&
    !matchesAnyGlob(relativePath, exemptionGlobs(manifest))
  );
}

function isTransportMutationScopeFile(
  relativePath: string,
  manifest: DeterminismManifest,
): boolean {
  return (
    matchesAnyGlob(relativePath, [TRANSPORT_MUTATION_SCOPE_GLOB]) &&
    !matchesAnyGlob(relativePath, exemptionGlobs(manifest))
  );
}

/**
 * Static property name of a MemberExpression, dot or bracket form: `x.fetch` and `x['fetch']`
 * both resolve to `'fetch'`; a non-literal computed property (`x[someVariable]`) resolves to
 * `undefined` since its actual value isn't known statically.
 */
function staticMemberPropertyName(
  member: Rule.Node & { type: 'MemberExpression' },
): string | undefined {
  if (!member.computed) {
    return member.property.type === 'Identifier' ? member.property.name : undefined;
  }
  return member.property.type === 'Literal' && typeof member.property.value === 'string'
    ? member.property.value
    : undefined;
}

/**
 * Real-runtime call sites this rule flags, matched by AST shape rather than source text. Every
 * candidate identifier is additionally required to resolve to the ambient global (via ESLint's
 * own `sourceCode.isGlobalReference`, the same check `no-implied-eval` and friends use) — code
 * that destructures an injected runtime (`const { setTimeout } = runtime; setTimeout(...)`) or
 * shadows `Date`/`performance`/`crypto`/`Math` with a local binding is exactly the injection
 * pattern this gate exists to encourage, and must not be flagged for using it.
 */
function realRuntimeCallLabel(
  context: Rule.RuleContext,
  node: (Rule.Node & { type: 'CallExpression' | 'NewExpression' }) | undefined,
): string | undefined {
  if (!node) return undefined;

  if (node.type === 'NewExpression') {
    if (
      node.callee.type === 'Identifier' &&
      node.callee.name === 'Date' &&
      node.arguments.length === 0 &&
      context.sourceCode.isGlobalReference(node.callee)
    ) {
      return 'new Date()';
    }
    return undefined;
  }

  const callee = node.callee;
  if (
    callee.type === 'Identifier' &&
    (callee.name === 'setTimeout' || callee.name === 'setInterval') &&
    context.sourceCode.isGlobalReference(callee)
  ) {
    return `${callee.name}(`;
  }

  if (callee.type === 'MemberExpression') {
    const propertyName = staticMemberPropertyName(callee);
    const object = callee.object;
    if (
      propertyName &&
      object.type === 'Identifier' &&
      context.sourceCode.isGlobalReference(object)
    ) {
      const pair = `${object.name}.${propertyName}`;
      if (
        pair === 'Date.now' ||
        pair === 'performance.now' ||
        pair === 'crypto.randomUUID' ||
        pair === 'Math.random'
      ) {
        return `${pair}(`;
      }
    }
  }

  return undefined;
}

export function createNoRealRuntimeCallRule(
  manifest: DeterminismManifest,
  repoRoot: string,
): Rule.RuleModule {
  return {
    meta: {
      type: 'problem',
      docs: {
        description:
          'disallow direct setTimeout/setInterval/Date.now/new Date()/performance.now/crypto.randomUUID/Math.random inside a deterministic test directory not listed in scripts/determinism-manifest.json',
      },
      schema: [],
    },
    create(context) {
      const relativePath = toRepoRelativePosixPath(context.filename, repoRoot);
      if (!isDeterministicDirectoryFile(relativePath, manifest)) return {};

      function reportIfRealRuntimeCall(
        node: Rule.Node & { type: 'CallExpression' | 'NewExpression' },
      ) {
        const label = realRuntimeCallLabel(context, node);
        if (!label) return;
        context.report({
          node,
          message: `${label} is a real, non-deterministic runtime call inside a deterministic test directory (${relativePath}). ${DETERMINISM_ACTION_SENTENCE}`,
        });
      }

      return {
        CallExpression: reportIfRealRuntimeCall,
        NewExpression: reportIfRealRuntimeCall,
      };
    },
  };
}

export function createNoGlobalTransportMutationRule(
  manifest: DeterminismManifest,
  repoRoot: string,
): Rule.RuleModule {
  return {
    meta: {
      type: 'problem',
      docs: {
        description:
          'disallow (globalThis|global).(fetch|WebSocket|EventSource) = ... assignment anywhere under packages/ not listed in scripts/determinism-manifest.json',
      },
      schema: [],
    },
    create(context) {
      const relativePath = toRepoRelativePosixPath(context.filename, repoRoot);
      if (!isTransportMutationScopeFile(relativePath, manifest)) return {};

      return {
        AssignmentExpression(node) {
          if (node.operator !== '=') return;
          const left = node.left;
          if (left.type !== 'MemberExpression') return;

          // Dot form (`x.fetch`) and bracket-with-string-literal form (`x['fetch']`) both count;
          // a non-literal computed property (`x[someVariable]`) can't be resolved statically.
          const propertyName = staticMemberPropertyName(left);
          if (!propertyName || !['fetch', 'WebSocket', 'EventSource'].includes(propertyName)) {
            return;
          }

          // `global`/`globalThis` must resolve to the ambient process global, not a local
          // parameter or variable of the same name (e.g. `function install(global: Env) { ... }`)
          // — otherwise this rule would reject valid injected-environment code.
          if (
            left.object.type !== 'Identifier' ||
            (left.object.name !== 'globalThis' && left.object.name !== 'global') ||
            !context.sourceCode.isGlobalReference(left.object)
          ) {
            return;
          }

          context.report({
            node,
            message: `Direct assignment to ${left.object.name}.${propertyName} mutates process-global transport state (${relativePath}). ${DETERMINISM_ACTION_SENTENCE}`,
          });
        },
      };
    },
  };
}

/**
 * Flat-config entries wiring both determinism rules for `manifest`/`repoRoot`, plus a
 * `noInlineConfig` block scoped to the manifest's test-directory shapes. That scoping is narrow
 * enough to be safe repo-wide (verified empty via `git grep eslint-disable` across
 * `packages/*\/src/test/**` and `packages/integration/test/lifecycle-contract/**` as of this
 * writing) and gives the real-runtime-call rule genuine non-bypass through the ordinary
 * `turbo run lint` path; the transport-mutation rule's non-bypass guarantee comes from
 * `scripts/check-determinism.ts` instead, per the comment above.
 */
export function createDeterminismConfig(
  manifest: DeterminismManifest,
  repoRoot: string,
): Linter.Config[] {
  return [
    {
      files: [commonFiles],
      plugins: {
        determinism: {
          rules: {
            'no-real-runtime-call': createNoRealRuntimeCallRule(manifest, repoRoot),
            'no-global-transport-mutation': createNoGlobalTransportMutationRule(manifest, repoRoot),
          },
        },
      },
      rules: {
        'determinism/no-real-runtime-call': 'error',
        'determinism/no-global-transport-mutation': 'error',
      },
    },
    {
      files: ['src/test/**', 'test/lifecycle-contract/**'],
      linterOptions: { noInlineConfig: true },
    },
  ];
}

/** Rejects `""`/whitespace-only strings too — an empty `reason` or `owningIssue` is not a real one. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDeterminismManifestExemption(value: unknown): value is DeterminismManifestExemption {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record.path) &&
    isNonEmptyString(record.reason) &&
    isNonEmptyString(record.owner) &&
    isNonEmptyString(record.owningIssue)
  );
}

/** Runtime shape guard for `scripts/determinism-manifest.json` — no `as` cast past this point. */
export function parseDeterminismManifest(value: unknown): DeterminismManifest {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('determinism-manifest.json must be a JSON object');
  }
  const record = value as Record<string, unknown>;

  const { deterministicDirectories, realRuntimeExemptions } = record;
  if (
    !Array.isArray(deterministicDirectories) ||
    !deterministicDirectories.every(isNonEmptyString)
  ) {
    throw new TypeError(
      'determinism-manifest.json "deterministicDirectories" must be an array of non-empty strings',
    );
  }
  if (
    !Array.isArray(realRuntimeExemptions) ||
    !realRuntimeExemptions.every(isDeterminismManifestExemption)
  ) {
    throw new TypeError(
      'determinism-manifest.json "realRuntimeExemptions" must be an array of {path, reason, owner, owningIssue}, each a non-empty string',
    );
  }

  return { deterministicDirectories, realRuntimeExemptions };
}

export const determinismManifest = parseDeterminismManifest(rawDeterminismManifest);

/**
 * Shared ESLint flat config array. Each package imports this and spreads it,
 * appending package-specific overrides before the final Prettier block.
 *
 * Usage in a package `eslint.config.ts`:
 *
 * ```ts
 * import { baseConfig, testOverrides, prettierConfig } from '../../eslint.config.base.ts';
 * export default [...baseConfig, ...testOverrides, prettierConfig];
 * ```
 */

export const baseConfig = [
  {
    ignores: [
      '**/{dist,build,coverage,.bun}/**',
      '**/node_modules/**',
      '**/*.lock',
      '**/README.md',
      '**/package.json',
    ],
  },

  js.configs.recommended,

  {
    files: [commonFiles],
    languageOptions: {
      ecmaVersion: 'latest' as const,
      sourceType: 'module' as const,
      parserOptions: {
        ecmaFeatures: {
          importAttributes: true,
        },
      },
      globals: {
        Bun: 'readonly',
        ...globals.node,
        ...globals.browser,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    plugins: commonPlugins,
    settings: {
      'import/resolver': {
        typescript: { project: ['./tsconfig.json'], alwaysTryTypes: true },
      },
    },
    rules: {
      ...coreRules,
      ...promiseRules,
      ...unicornRules,
      ...importRules,
      ...eslintCommentsRules,
      ...regexpRules,
      'import/no-cycle': 'warn',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  ...tseslint.configs.recommended,

  ...tseslint.configs.recommendedTypeChecked.map((configuration) => ({
    ...configuration,
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ...(configuration.languageOptions ?? {}),
      parserOptions: { projectService: true },
    },
    rules: {
      ...(configuration.rules ?? {}),
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  })),

  // `import.meta.dirname`, not the Bun-only `import.meta.dir`: `eslint .` runs under whatever
  // interpreter its `#!/usr/bin/env node` shebang resolves to. Direct `bun <path-to-eslint>`
  // stays on Bun, but `bun run lint` (what `turbo run lint`/CI actually invokes) forwards to
  // real Node, where `import.meta.dir` is undefined. `dirname` is the one spelling both runtimes
  // support.
  ...createDeterminismConfig(determinismManifest, import.meta.dirname),
];

export const testOverrides = [
  {
    files: testFiles,
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
        jest: 'readonly',
        mock: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-magic-numbers': 'off',
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-vars': 'off',
    },
  },
];

export const prettierConfig = eslintConfigPrettier;
