// Compile-time guard: bureau-types must not export named values of any kind.
//
// The two @ts-expect-error directives below suppress "Namespace has no exported
// member" errors. If either error disappears, it means createBureau or
// createAgent has been re-added as a named export (including `export declare`)
// — which violates the types-only contract of this subpath.

import type * as BureauTypes from './bureau-types.ts';

// @ts-expect-error — 'createBureau' must not be a named export; use CreateBureauFn instead
declare const _createBureau: BureauTypes.createBureau;

// @ts-expect-error — 'createAgent' must not be a named export; use CreateAgentFn instead
declare const _createAgent: BureauTypes.createAgent;

// Suppress "declared but never used" without triggering verbatimModuleSyntax concerns.
void _createBureau;
void _createAgent;
