import type { RuntimeComposition } from './runtime-composition';
import { getRuntimeCompositionTestingSeams } from './test';

declare const runtime: RuntimeComposition;

// Production RuntimeComposition must not expose mutable test hooks.
// @ts-expect-error — resolver mutation hooks live behind the bureau/test entrypoint.
void runtime.__testing;

// Test code can still reach the same seams through the explicit test surface.
void getRuntimeCompositionTestingSeams(runtime);
