// Compile-time guard: bureau-types must not export createBureau or createAgent
// as named exports (including `export declare function` ambient declarations).
//
// The two @ts-expect-error directives below suppress "Namespace has no exported member" errors.
// If either error disappears, it means createBureau or createAgent has been re-added as a named
// export — which would make the ./bureau-types subpath appear to have callable value exports
// while the exports map exposes only a types condition.

import type * as BureauTypes from './bureau-types.ts';

// @ts-expect-error — 'createBureau' must not be a named export; use CreateBureauFn instead
declare const _createBureau: typeof BureauTypes.createBureau;

// @ts-expect-error — 'createAgent' must not be a named export; use CreateAgentFn instead
declare const _createAgent: typeof BureauTypes.createAgent;

// Suppress "declared but never used" without triggering verbatimModuleSyntax concerns.
void _createBureau;
void _createAgent;
