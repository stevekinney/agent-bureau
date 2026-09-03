import type { RuntimeServices } from 'lifecycle';

import type { RuntimeComposition } from './runtime-composition';
import type { BureauOptions } from './types';

declare const runtime: RuntimeComposition;

// AB-260: `resolveRunServices`, `buildScheduledRunServices`, and
// `loadCommittedScheduledActiveSkills` are folded directly onto the
// returned `RuntimeComposition` — genuine capabilities of every caller (test
// or production), not test-only hooks reached through a WeakMap side
// channel (the retired `RuntimeCompositionTestingSeams`/
// `getRuntimeCompositionTestingSeams`).
void runtime.resolveRunServices;
void runtime.buildScheduledRunServices;
void runtime.loadCommittedScheduledActiveSkills;

// @ts-expect-error — the retired seam accessor is gone; a production
// `RuntimeComposition` never exposed it and no compatibility shim remains.
void runtime.setSessionStore;

// AB-260: `BureauOptions.runtime` accepts a `RuntimeServices` instance,
// composed once at construction.
declare const runtimeServices: RuntimeServices;
declare const options: BureauOptions;
void ({ ...options, runtime: runtimeServices } satisfies BureauOptions);
