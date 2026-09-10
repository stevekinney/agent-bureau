// Fixture: a source-side test helper module that does NOT end in `.test.ts` (the shape of a real
// consumer's shared conformance suite, e.g. packages/operative/src/test/reactive-source-suite.ts).
// It reaches another package's internal path with no manifest entry naming it — reported only
// because `packages/*/src/test/**/*.ts` is scanned on its own, not merely `*.test.ts` files.
import type { internalThing } from 'fixture-pkg-a/src/internal';

export type ReExported = typeof internalThing;
