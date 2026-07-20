import { baseConfig, prettierConfig, testOverrides } from '../../eslint.config.base.ts';

export default [
  // Dynamically written and torn down by src/*.test.ts (beforeEach/afterEach
  // fixture writes). ESLint's directory walk can race the test runner's
  // rmSync/Bun.write cycle and throw ENOENT mid-scan when both run
  // concurrently under `turbo run validate`; these are fixture data, not
  // source to lint, so exclude them outright.
  { ignores: ['src/__test-fixtures__/**', 'src/__suite-test-fixtures__/**'] },
  ...baseConfig,
  ...testOverrides,
  prettierConfig,
];
