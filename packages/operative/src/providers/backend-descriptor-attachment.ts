/**
 * Backend-descriptor attachment (AB-64 AC2, AB-245) — lets a provider
 * factory (`createAnthropicProvider` and its siblings), `createRoutingGenerate`,
 * and `createLazyGenerate` stamp the `BackendDescriptor`(s) behind a
 * `GenerateFunction`/`StreamingGenerateFunction` at construction time, and
 * lets a caller read them back later without inferring anything.
 *
 * Mirrors `runnable-agent.ts`'s `OPERATIVE_RESOLVE_RUN_OPTIONS` pattern
 * exactly: a registry symbol created with `Symbol.for(...)`, not `Symbol()`,
 * so it identifies consistently across separate copies of this package
 * (e.g. a durable engine in another package reading a descriptor a
 * different package instance attached).
 */

import type { BackendDescriptor } from './model-catalog.ts';
import type { GenerateFunction, StreamingGenerateFunction } from './types.ts';

/** A function `withBackendDescriptors`/`readBackendDescriptors` can operate on. */
type DescriptorBearingFunction = GenerateFunction | StreamingGenerateFunction;

/**
 * Registry symbol key. `Symbol.for` (not `Symbol()`) so it identifies
 * consistently across package instances — see the module doc comment.
 *
 * @internal
 */
const OPERATIVE_BACKEND_DESCRIPTORS: unique symbol = Symbol.for(
  '@lostgradient/operative/backend-descriptors',
);

/**
 * Optional capability a `GenerateFunction`/`StreamingGenerateFunction` may
 * carry: the `BackendDescriptor`(s) behind it, attached by
 * `withBackendDescriptors` at construction time.
 *
 * @internal
 */
interface BackendDescriptorBearing {
  readonly [OPERATIVE_BACKEND_DESCRIPTORS]?: readonly BackendDescriptor[];
}

const EMPTY_DESCRIPTORS: readonly BackendDescriptor[] = Object.freeze([]);

/**
 * Attaches `descriptors` to `generate` under the registry symbol and
 * returns `generate` itself (mutated in place, not a wrapper) so callers can
 * write `return withBackendDescriptors(generate, descriptors);` as a tail
 * expression. `descriptors` is defensively copied and frozen before
 * attachment, so a caller's later mutation of the array it passed in can
 * never retroactively change what a already-constructed generate function
 * reports.
 */
export function withBackendDescriptors<T extends DescriptorBearingFunction>(
  generate: T,
  descriptors: readonly BackendDescriptor[],
): T {
  const frozenDescriptors = Object.freeze([...descriptors]);
  const target = generate as T & {
    [OPERATIVE_BACKEND_DESCRIPTORS]?: readonly BackendDescriptor[];
  };
  target[OPERATIVE_BACKEND_DESCRIPTORS] = frozenDescriptors;
  return generate;
}

/**
 * Reads the `BackendDescriptor`(s) attached to `generate` by
 * `withBackendDescriptors`. Returns a frozen empty array — never `undefined`
 * and never an inferred descriptor — for a function with nothing attached.
 * A plain synchronous property read: no lazy-module load, no provider call,
 * no background work.
 */
export function readBackendDescriptors(
  generate: DescriptorBearingFunction,
): readonly BackendDescriptor[] {
  const registry = generate as DescriptorBearingFunction & BackendDescriptorBearing;
  return registry[OPERATIVE_BACKEND_DESCRIPTORS] ?? EMPTY_DESCRIPTORS;
}
