// Type spike pinning the fix for issue #271: "Toolbox is invariant in its
// tool-tuple parameter: bare Toolbox cannot accept createToolbox([...])
// output."
//
// Conventions (matching packages/conversationalist/src/state-snapshot.test-d.ts
// and packages/operative/src/bureau.test-d.ts):
//   - All `declare const` are type-level only; nothing runs at runtime.
//   - This file is validated by `tsc`/`check-types` ONLY — never run under
//     `bun test`. Running it as a script produces spurious syntax errors;
//     the only oracle here is the TypeScript compiler.
//
// Background: `Toolbox<TTools extends readonly Tool[] = readonly Tool[]>` is
// invariant in `TTools` — the tuple appears in both input and output
// positions (the typed `execute` overloads, `extend`, `tools`,
// `getAvailable`, `getTool`). That means the bare `Toolbox` default is NOT a
// supertype of a concretely-typed `Toolbox<ConcreteTools>`, so
// `createToolbox([...])`'s result cannot be assigned to a bare-`Toolbox`-typed
// variable without a cast.
//
// `AnyToolbox` (exported from `create-toolbox.ts`) is the fix: a genuine
// erased supertype every `Toolbox<TTools>` structurally satisfies, for any
// `TTools`, with no cast. `Toolbox<TTools>` itself stays invariant on
// purpose — the typed `execute` overloads and `tools()` genuinely need the
// precise tuple, and that precision is only useful if it's still checked.

import { z } from 'zod';

import { createTool } from './create-tool';
import { type AnyToolbox, createToolbox, type Toolbox } from './create-toolbox';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Look up the current weather for a location.',
  input: z.object({ location: z.string() }),
  execute: () => Promise.resolve({ temperature: 72 }),
});

// ---------------------------------------------------------------------------
// 1. The issue's exact repro, fixed: a concretely-typed toolbox assigns to
//    `AnyToolbox` with NO cast and NO `any`.
// ---------------------------------------------------------------------------

const concreteToolbox = createToolbox([weatherTool]);
const asAnyToolbox: AnyToolbox = concreteToolbox;
void asAnyToolbox;

// ---------------------------------------------------------------------------
// 2. A toolbox with multiple, differently-shaped tools also assigns cleanly —
//    this isn't a single-tool coincidence.
// ---------------------------------------------------------------------------

const clockTool = createTool({
  name: 'get_time',
  description: 'Return the current time.',
  input: z.object({}),
  execute: () => Promise.resolve({ iso: new Date().toISOString() }),
});

const multiToolToolbox = createToolbox([weatherTool, clockTool]);
const multiAsAnyToolbox: AnyToolbox = multiToolToolbox;
void multiAsAnyToolbox;

// ---------------------------------------------------------------------------
// 3. An empty toolbox (createToolbox()) also assigns cleanly — the zero-tool
//    tuple is just as concrete as a populated one.
// ---------------------------------------------------------------------------

const emptyToolbox = createToolbox();
const emptyAsAnyToolbox: AnyToolbox = emptyToolbox;
void emptyAsAnyToolbox;

// ---------------------------------------------------------------------------
// 4. AnyToolbox.extend() stays erased: extending a concrete toolbox and
//    assigning the result back to AnyToolbox requires no cast either.
// ---------------------------------------------------------------------------

const extended: AnyToolbox = asAnyToolbox.extend(clockTool);
void extended;

// ---------------------------------------------------------------------------
// 5. Residual limitation, documented: the bare `Toolbox` default (NOT
//    `AnyToolbox`) is still genuinely invariant — this is intentional, not a
//    regression. `execute`'s tuple-aware overloads need the real tuple to
//    type call/result pairs; erasing it there would silently defeat the
//    point of `Toolbox<TTools>`. If this `@ts-expect-error` stops erroring,
//    something changed the variance behavior this test exists to pin.
// ---------------------------------------------------------------------------

// @ts-expect-error — bare `Toolbox` (default `TTools = readonly Tool[]`) is
// still invariant; only `AnyToolbox` is the erased supertype. This is the
// documented residual limitation from issue #271.
const asBareToolbox: Toolbox = concreteToolbox;
void asBareToolbox;
