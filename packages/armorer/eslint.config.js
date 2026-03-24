import { baseConfig, prettierConfig, testOverrides } from '../../eslint.config.base.ts';

export default [
  ...baseConfig,

  // Schema utility files - these work with Zod internals which requires permissive type handling
  {
    files: [
      'src/schema-utilities.ts',
      'src/inspect.ts',
      'src/create-tool.ts',
      'src/create-toolbox.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      'promise/catch-or-return': 'off',
      'prefer-const': 'off',
    },
  },

  ...testOverrides,

  prettierConfig,
];
