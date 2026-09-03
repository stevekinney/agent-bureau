// Type-level contract for AB-255. This file is checked by `tsc --noEmit`; it
// is not a runtime Bun test.
//
// Proves the exhaustiveness-check MECHANISM `OPERATIVE_EVENT_TYPES` and
// `COMBINED_OPERATIVE_EVENT_TYPES` use — `Exclude<EventType, ArrayMembers>
// extends never ? true : [...]`, assigned to a `const` typed `true` — really
// does reject a missing array member at compile time. It exercises that
// mechanism against a small isolated event-map mimic rather than the real
// `OperativeEventClassMap`/`CombinedOperativeEventClassMap`: mutating those
// to omit a member on purpose would break the very invariant this file
// exists to protect, and defeat `OPERATIVE_EVENT_TYPES`'s own `satisfies
// readonly OperativeEventType[]` check before the exhaustiveness assertion
// is even reached.

import { COMBINED_OPERATIVE_EVENT_TYPES, OPERATIVE_EVENT_TYPES } from './events';

interface SampleEventClassMap {
  'sample.a': { type: 'sample.a' };
  'sample.b': { type: 'sample.b' };
  'sample.c': { type: 'sample.c' };
}

type SampleEventType = Extract<keyof SampleEventClassMap, string>;

// Complete: every member of `SampleEventType` is present. Compiles clean.
const COMPLETE_SAMPLE_TYPES = [
  'sample.a',
  'sample.b',
  'sample.c',
] as const satisfies readonly SampleEventType[];

type MissingFromComplete = Exclude<SampleEventType, (typeof COMPLETE_SAMPLE_TYPES)[number]>;

const _completeIsExhaustive: MissingFromComplete extends never
  ? true
  : ['missing', MissingFromComplete] = true;
void _completeIsExhaustive;
void COMPLETE_SAMPLE_TYPES;

// Incomplete: `'sample.c'` is missing. The exhaustiveness guard must reject
// this — `MissingFromIncomplete` resolves to `'sample.c'`, so `true` is not
// assignable to it, and the `@ts-expect-error` below is required for this
// file to type-check at all. Delete the array member deliberately dropped
// here (or the `@ts-expect-error`) and `check-types` goes red — this is the
// live proof, not just documentation, that a key added to an event-class
// map without a matching array entry fails `bun run --cwd packages/operative
// check-types`, exactly as AB-255's acceptance criteria require of the real
// `OPERATIVE_EVENT_TYPES`/`COMBINED_OPERATIVE_EVENT_TYPES` pair.
const INCOMPLETE_SAMPLE_TYPES = [
  'sample.a',
  'sample.b',
] as const satisfies readonly SampleEventType[];

type MissingFromIncomplete = Exclude<SampleEventType, (typeof INCOMPLETE_SAMPLE_TYPES)[number]>;

// @ts-expect-error — MissingFromIncomplete is 'sample.c', not never, so `true` isn't assignable.
const _incompleteIsExhaustive: MissingFromIncomplete extends never
  ? true
  : ['missing', MissingFromIncomplete] = true;
void _incompleteIsExhaustive;
void INCOMPLETE_SAMPLE_TYPES;

// Live proof that the real arrays are exhaustive today: this file importing
// and referencing them compiles, and `events.ts`'s own
// `_assertOperativeEventTypesExhaustive`/`_assertCombinedOperativeEventTypesExhaustive`
// constants (built with the exact mechanism proved above) are checked every
// time `events.ts` itself is type-checked.
void OPERATIVE_EVENT_TYPES;
void COMBINED_OPERATIVE_EVENT_TYPES;
