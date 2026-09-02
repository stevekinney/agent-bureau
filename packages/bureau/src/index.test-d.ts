// Type-level tripwire (review finding, PRRT_kwDORvupsc6elgnL): the package
// barrel presents `AgentRunForName` and `BureauRunOptions` as exported named
// types in the public API, but `index.ts` used to omit both from its
// re-export lists — `AgentRunForName` from `./agent-catalog`, `BureauRunOptions`
// from `./types` — so a consumer naming either type had to reach past the
// barrel into an internal module path. `export type { X } from './module'`
// only fails to compile if `X` doesn't exist in `./module` at all — it does
// NOT fail if `X` exists but simply isn't re-exported from the barrel — so
// this file, which imports both ONLY from the barrel (`./index`), is the
// actual tripwire: it fails to compile if either re-export regresses.

import type { AgentRunForName, BureauRunOptions } from './index';

declare const runOptions: BureauRunOptions;
declare const runResult: AgentRunForName<Record<string, never>, never>;
void runOptions;
void runResult;
