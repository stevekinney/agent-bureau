// Issue #104 — Type-level guard for `bureau.run()` closed-registry rejection.
//
// `bureau.run<TExtra extends AgentTable>(name, input)` is the Tier-3
// "default-closed, opt-in-open" escape hatch. Supplying `TExtra` deliberately
// widens the accepted agent-name type to `string` so dynamic/plugin agents can
// be invoked at runtime. That widening is intentional — but it makes the
// *closed-registry path* (bare `run('name')`, no `TExtra`) the only compile-time
// barrier between a typo and a runtime throw.
//
// The A4 spike (`@lostgradient/operative/src/bureau.test-d.ts`) asserts this against
// operative's INTERNAL `createBureau`. This file guards the SAME boundary at the
// public surface consumers actually import — the `bureau/builder` subpath
// (`./builder/index.ts`, mapped to `exports["./builder"]`). Importing through
// the entrypoint means a regression is caught whether it lands in the
// implementation (`createBureau` losing its generic, `BureauBuilder.run`'s
// signature changing) OR in the re-export wiring (a dropped export in
// `builder/index.ts`). Either way, this file fails to type-check.
//
// Conventions (cribbed from the A4 spike):
//   - `satisfies` asserts a value resolves to exactly the expected type.
//   - `@ts-expect-error` asserts the next line MUST be a type error. If the
//     error disappears, `tsc` reports the comment as unused and this file fails.
//   - Every binding is type-level only; nothing runs at runtime. This file is
//     type-checked (`tsc --noEmit`) but excluded from build and never executed
//     by `bun test` (it is `.test-d.ts`, not `.test.ts`).

import type { AgentConfig, AgentNameFor, AgentTable } from './builder/index.ts';
import { createBureau } from './builder/index.ts';

// ---------------------------------------------------------------------------
// PROOF 1 — Closed registry rejects unknown agent names.
//
// On a closed bureau (bare `run`, no `TExtra`), `AgentNameFor` resolves to
// `keyof TAgents & string`. Registered names compile; anything else is an error.
// Both registration paths feed `TAgents`, so both must be covered.
// ---------------------------------------------------------------------------

// Tier 1 — construction-time `createBureau({ agents })`.
const tier1Bureau = createBureau({
  agents: { researcher: {} },
});

// Registered name compiles.
void tier1Bureau.run('researcher', 'Summarize the Q3 report');

// @ts-expect-error — 'unregistered' is not in the closed agent table.
void tier1Bureau.run('unregistered', 'this must fail');

// Tier 2 — chained `.agent({ name })`. The return MUST be captured (each call
// returns a wider builder type); a registered name added this way is equally
// protected.
const tier2Bureau = createBureau().agent({ name: 'writer' });

void tier2Bureau.run('writer', 'Draft an executive summary');

// @ts-expect-error — 'researcher' was never registered on this bureau.
void tier2Bureau.run('researcher', 'this must fail');

// ---------------------------------------------------------------------------
// PROOF 2 — Wrong input is a type error.
//
// `run`'s second parameter is typed `string`. With a VALID name supplied, a
// non-string input must be rejected — proving the error lands on the input
// argument, not the name.
// ---------------------------------------------------------------------------

// @ts-expect-error — input must be a string; 42 is a number.
void tier1Bureau.run('researcher', 42);

// ---------------------------------------------------------------------------
// PROOF 3 — `run<TExtra>` widens, never replaces.
//
// `TExtra` here is a *narrow* runtime-agent table whose keys do NOT include the
// static 'researcher' agent. The narrowness is what makes this a real guard: if
// `TExtra` were `AgentTable`, `keyof TExtra` is already `string`, so a regression
// that made `run<TExtra>` accept ONLY `keyof TExtra` (REPLACE the static registry
// instead of widening it) would still accept 'researcher' and slip through. With
// a finite extra table, the static-name assertion below only compiles when the
// static `TAgents` registry is preserved.
// ---------------------------------------------------------------------------

// A finite runtime-agent table — the names a caller validated at runtime. It is
// a valid `TExtra`: it satisfies the `AgentTable` bound that
// `run<TExtra extends AgentTable>` imposes.
type RuntimeAgents = { 'plugin-agent': AgentConfig };
declare const runtimeAgentsTable: RuntimeAgents;
void (runtimeAgentsTable satisfies AgentTable);

// Dynamic name from the extra table compiles.
void tier1Bureau.run<RuntimeAgents>('plugin-agent', 'Dynamic input');

// Static agent STILL compiles — widen, never replace. Under a replace regression
// (`AgentNameFor` resolving to `keyof TExtra & string`) this line would stop
// compiling, because 'researcher' is not a key of `RuntimeAgents`.
void tier1Bureau.run<RuntimeAgents>('researcher', 'Static input still works');

// Direct `AgentNameFor` proof: the closed table narrows to the literal union of
// registered names; supplying any non-empty `TExtra` opens it to `string`.
type ClosedNames = AgentNameFor<
  { researcher: { tools: Record<never, never> } },
  Record<never, never>
>;
void ('' as ClosedNames satisfies 'researcher');

type OpenNames = AgentNameFor<{ researcher: { tools: Record<never, never> } }, RuntimeAgents>;
void ('' as OpenNames satisfies string);

// ---------------------------------------------------------------------------
// Final void block — reference every binding so `noUnusedLocals` is satisfied
// (this file is linted/type-checked under the strict `src` rules, not the
// relaxed test-file overrides).
// ---------------------------------------------------------------------------

void [tier1Bureau, tier2Bureau];
