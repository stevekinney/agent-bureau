// Fixture: the same unreachable cross-package import, with no manifest entry naming this file at
// all. Reported.
import type { internalThing } from 'fixture-pkg-a/src/internal';

export type ReExported = typeof internalThing;
