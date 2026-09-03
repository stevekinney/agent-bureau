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
 * Recursively freezes `value`'s own object graph in place: `value` itself,
 * then every own-property value reachable from it, depth-first — including
 * beneath a node that is already frozen. That last part matters: a node can
 * be shallow-frozen (`Object.freeze({ ...descriptor, aliases: mutableAliases
 * })`) while a property it holds is still a fully mutable array or object,
 * so skipping traversal once `Object.isFrozen(value)` is true — rather than
 * only skipping the redundant `Object.freeze(value)` call itself — would
 * leave exactly that nested structure open to later mutation. `createModelCatalog`'s
 * own seed rows are already deeply frozen at their source, so this still
 * does no real freezing work for them; it only costs a full property-value
 * walk confirming that.
 *
 * Freezes the caller's own object graph in place rather than copying it
 * first — the same "freeze on receipt, preserve reference identity" pattern
 * `create-lazy-agent.ts`'s `freezeGenerationProfile` already uses for the
 * analogous `generationProfile` case. `seen` guards against revisiting the
 * same object twice — a shared frozen sub-object reachable from more than
 * one property (or, in principle, a reference cycle) — rather than against
 * infinite recursion in the ordinary case, since `BackendDescriptor`'s own
 * shape has none.
 *
 * The `Record<string, unknown>` cast is a narrow, standard reflection
 * pattern for a generic recursive-freeze helper: `Object.getOwnPropertyNames`
 * only ever returns real own-property keys of `value`, so indexing through
 * them is safe regardless of `value`'s static shape.
 *
 * Exported (not re-exported through a package barrel — a plain cross-module
 * import, same as `runnable-agent.ts`'s `OPERATIVE_RESOLVE_RUN_OPTIONS`) so
 * `create-lazy-agent.ts`'s `freezeGenerationProfile` can reuse it for the
 * descriptors a caller-supplied `AgentGenerationProfile` carries, rather
 * than duplicating this traversal there.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value;
  }
  if (seen.has(value)) return value;
  seen.add(value);
  if (!Object.isFrozen(value)) Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return value;
}

/**
 * Attaches `descriptors` to `generate` under the registry symbol and
 * returns `generate` itself (mutated in place, not a wrapper) so callers can
 * write `return withBackendDescriptors(generate, descriptors);` as a tail
 * expression. The descriptor array is defensively copied and frozen, and
 * each descriptor's own object graph is deep-frozen in place, so a caller's
 * later mutation — of the array it passed in, or of a field on one of the
 * descriptor objects themselves (`descriptor.model`, `descriptor.modalities`,
 * an entry in `descriptor.aliases`, …) — can never retroactively change what
 * an already-constructed generate function reports.
 */
export function withBackendDescriptors<T extends DescriptorBearingFunction>(
  generate: T,
  descriptors: readonly BackendDescriptor[],
): T {
  const frozenDescriptors = Object.freeze(descriptors.map((descriptor) => deepFreeze(descriptor)));
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

/** `(provider, endpoint, model)` as a collision-safe map key. */
function tripleKey(descriptor: BackendDescriptor): string {
  return JSON.stringify([descriptor.provider, descriptor.endpoint, descriptor.model]);
}

/**
 * Total order over two descriptors sharing the same `(provider, endpoint,
 * model)` triple — content-only, so which one `unionBackendDescriptors`
 * keeps never depends on candidate array order. Mirrors
 * `create-routing-generate.ts`'s `conservativeOrder` exactly: an
 * `endpointAmbiguous` descriptor sorts first (the more conservative,
 * capability-flags-false reading), and `freshness` (lexicographic, which is
 * also chronological for an ISO 8601 UTC timestamp) is the final tiebreak
 * when every other field is identical.
 */
function conservativeOrder(a: BackendDescriptor, b: BackendDescriptor): number {
  const aAmbiguous = a.endpointAmbiguous === true;
  const bAmbiguous = b.endpointAmbiguous === true;
  if (aAmbiguous !== bAmbiguous) return aAmbiguous ? -1 : 1;
  const { freshness: aFreshness, ...aRest } = a;
  const { freshness: bFreshness, ...bRest } = b;
  const aSerialized = JSON.stringify(aRest);
  const bSerialized = JSON.stringify(bRest);
  if (aSerialized !== bSerialized) return aSerialized < bSerialized ? -1 : 1;
  return aFreshness < bFreshness ? -1 : aFreshness > bFreshness ? 1 : 0;
}

/**
 * The ordered union of every list in `descriptorLists`, deduplicated by
 * `(provider, endpoint, model)` and ordered by that triple lexicographically
 * (AB-64 AC2, AB-245, AB-288) — so a multi-candidate wrapper's attached
 * descriptors are deterministic regardless of candidate declaration order or
 * which descriptors are shared across candidates. A collision (two
 * candidates' descriptors sharing the same triple but disagreeing on
 * content) is resolved by `conservativeOrder`, not by insertion order.
 *
 * Used by `createFallbackGenerate` and `createFalloverGenerate` (AB-288) to
 * union their candidates' attached descriptors the same way
 * `create-routing-generate.ts`'s own (route-shaped) `unionDescriptors`
 * unions routes' — see that module for the fuller rationale this shares.
 */
export function unionBackendDescriptors(
  descriptorLists: readonly (readonly BackendDescriptor[])[],
): readonly BackendDescriptor[] {
  const byKey = new Map<string, BackendDescriptor>();
  for (const descriptors of descriptorLists) {
    for (const descriptor of descriptors) {
      const key = tripleKey(descriptor);
      const existing = byKey.get(key);
      if (!existing || conservativeOrder(descriptor, existing) < 0) {
        byKey.set(key, descriptor);
      }
    }
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, descriptor]) => descriptor);
}
