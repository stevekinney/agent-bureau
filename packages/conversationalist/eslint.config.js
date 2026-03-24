import { baseConfig, prettierConfig, testOverrides } from '../../eslint.config.base.ts';

export default [...baseConfig, ...testOverrides, prettierConfig];
