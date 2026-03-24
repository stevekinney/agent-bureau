import { fixupPluginRules } from '@eslint/compat';
import js from '@eslint/js';
import type { Linter } from 'eslint';
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

const commonFiles = '**/*.{js,jsx,cjs,mjs,ts,tsx}';

export const testFiles = [
  '**/*.{test,spec}.{js,jsx,ts,tsx}',
  '**/test/**/*.{js,jsx,ts,tsx}',
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
