// Compile-time guard: bureau-types must not export runtime callable values.
//
// The two @ts-expect-error directives below suppress "Namespace has no exported member" errors.
// If either error disappears, it means createBureau/createAgent has been reintroduced as a named export
// (including as an `export declare` value), which would re-create the type/runtime mismatch this file guards against.

import type * as BureauTypes from './bureau-types.ts';

// @ts-expect-error — 'createBureau' must not be a named export; use CreateBureauFn instead
declare const _createBureau: BureauTypes.createBureau;

// @ts-expect-error — 'createAgent' must not be a named export; use CreateAgentFn instead
declare const _createAgent: BureauTypes.createAgent;

// Suppress "declared but never used" without triggering verbatimModuleSyntax concerns.
void _createBureau;
void _createAgent;
