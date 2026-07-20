// Type spike proving ConversationHistory survives Svelte 5's `$state.snapshot`
// mapped type without hitting TS2589 ("Type instantiation is excessively deep
// and possibly infinite"). See GitHub issue #245.
//
// Conventions (matching packages/operative/src/bureau.test-d.ts):
//   - All `declare const` are type-level only; nothing runs at runtime.
//   - This file is validated by `tsc`/`check-types` ONLY — never run under
//     `bun test`. Running it as a script produces spurious syntax errors;
//     the only oracle here is the TypeScript compiler.
//
// `SvelteSnapshot<T>` below is a structural copy of Svelte 5's
// `$state.Snapshot<T>` (svelte/types/index.d.ts, verified against the real
// `svelte@5.56.7` ambient types and `conversationalist@0.4.1` as published
// to npm — the exact combination the issue was filed against). We do NOT
// add a `svelte` dependency to conversationalist just to prove this; the
// mapped-type shape is what recurses, and copying it here reproduces the
// exact TS2589 failure mode a Svelte consumer hits.
//
// Two details were required to reproduce the failure with plain `tsc`
// (confirmed empirically — a naive copy or a `void`-discarded result does
// NOT reproduce it):
//   1. The index-signature branch must use `{ [key: string]: any }`,
//      matching Svelte's real definition exactly. Substituting `unknown`
//      silently avoids the bug instead of proving the fix.
//   2. The snapshot call must be forced into a `ConversationHistory`-typed
//      return position (a function's declared return type), matching the
//      `function snapshot(): ConversationHistory { return $state.snapshot(...) }`
//      pattern every downstream consumer uses. Discarding the result with
//      `void` or letting TS merely infer the result type does not force the
//      assignability check that blows the recursion budget.

import type { ConversationHistory } from './types';

type Primitive = string | number | bigint | boolean | null | undefined;

/** Structural stand-in for `$state.Cloneable` (the structuredClone-able builtins). */
type Cloneable =
  | ArrayBuffer
  | DataView
  | Date
  | Error
  | Map<unknown, unknown>
  | RegExp
  | Set<unknown>
  | Blob;

type NonReactive<T> = T extends Date
  ? Date
  : T extends Map<infer K, infer V>
    ? Map<K, V>
    : T extends Set<infer K>
      ? Set<K>
      : T;

type SvelteSnapshot<T> = T extends Primitive
  ? T
  : T extends Cloneable
    ? NonReactive<T>
    : T extends { toJSON(): infer R }
      ? R
      : T extends readonly unknown[]
        ? { [K in keyof T]: SvelteSnapshot<T[K]> }
        : T extends Array<infer U>
          ? Array<SvelteSnapshot<U>>
          : T extends object
            ? // `any` here (not `unknown`) matches Svelte's real definition
              // exactly — see the file header for why that fidelity matters.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              T extends { [key: string]: any }
              ? { [K in keyof T]: SvelteSnapshot<T[K]> }
              : never
            : never;

// ---------------------------------------------------------------------------
// ASSERTION — `SvelteSnapshot<ConversationHistory>`, forced into a
// `ConversationHistory`-typed return position exactly like every downstream
// consumer's `snapshot()` helper, must typecheck without TS2589. Before the
// fix, this assignability check alone exhausts TypeScript's recursion depth:
// JSONValue's self-recursive union, combined with MultiModalContent's
// 9-member discriminated union (several of which embed JSONValue), combined
// with Svelte's own recursive mapped type, produces compound recursion
// TypeScript cannot cache.
// ---------------------------------------------------------------------------

declare const conversation: ConversationHistory;
declare function snap<T>(value: T): SvelteSnapshot<T>;

function snapshot(): ConversationHistory {
  return snap(conversation);
}

void snapshot;
