// Fixture: the same unreachable cross-package import, paired in the fixture manifest with a
// blackBoxTest that names no real test. Reported (the pairing cannot be trusted).
import type { internalThing } from 'fixture-pkg-a/src/internal';

export type ReExported = typeof internalThing;
