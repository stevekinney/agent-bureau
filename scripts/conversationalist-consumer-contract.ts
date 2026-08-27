export const ZOD_VERSION = '4.4.3';
export const TYPESCRIPT_VERSION = '6.0.3';
export const SVELTEKIT_VERSIONS = {
  adapterVercel: '6.3.4',
  kit: '2.70.3',
  viteSveltePlugin: '7.3.0',
  svelte: '5.56.9',
  vite: '8.2.1',
} as const;

export const FORBIDDEN_BROWSER_OUTPUT = ['node:module', 'externalized for browser compatibility'];
export const PUBLIC_SUBPATHS = [
  '.',
  './conversation',
  './context',
  './streaming',
  './projection',
  './history',
  './message',
  './utilities',
  './test',
  './markdown',
  './export',
  './schemas',
  './adapters/openai',
  './adapters/anthropic',
  './adapters/gemini',
  './redaction',
  './versioning',
  './sort',
  './composition',
] as const;
export const NODE_RANGE = '^20.19.0 || ^22.12.0 || >=24';
export const BROWSER_SUBPATHS = PUBLIC_SUBPATHS.filter(
  (subpath) => subpath !== './markdown' && subpath !== './export',
);

export function packageSpecifier(subpath: (typeof PUBLIC_SUBPATHS)[number]): string {
  return subpath === '.' ? 'conversationalist' : `conversationalist/${subpath.slice(2)}`;
}
