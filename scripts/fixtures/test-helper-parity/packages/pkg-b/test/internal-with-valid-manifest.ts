// Fixture: a cross-package import NOT reachable through the target package's exports map
// (`fixture-pkg-a/src/internal` is not a declared subpath), paired in the fixture manifest with a
// real black-box test. Not reported.
import type { internalThing } from 'fixture-pkg-a/src/internal';

export type ReExported = typeof internalThing;
