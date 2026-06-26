// Compile-time guard: bureau-types must not export runtime callable values.
//
// The two @ts-expect-error directives below suppress "Namespace has no exported
// member" errors. If either error disappears, it means createBureau or
// createAgent has been re-added as a runtime export — which would break
// consumers that import the types-only subpath at runtime.

import type * as BureauTypes from './bureau-types.ts';

// @ts-expect-error — 'createBureau' must not be a named export; use CreateBureauFn instead
declare const _createBureau: BureauTypes.createBureau;

// @ts-expect-error — 'createAgent' must not be a named export; use CreateAgentFn instead
declare const _createAgent: BureauTypes.createAgent;

// Suppress "declared but never used" without triggering verbatimModuleSyntax concerns.
void _createBureau;
void _createAgent;
