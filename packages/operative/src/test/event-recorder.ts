import type { RuntimeServices } from 'lifecycle';

import type { RunEvent } from '../agent-run';
import type { CombinedOperativeEventType } from '../events';
import { COMBINED_OPERATIVE_EVENT_TYPES } from '../events';
import type { CleanupAcknowledgement } from '../types';

// ---------------------------------------------------------------------------
// AB-92 AC8 shapes (event-recorder subset). `FiredFault`'s companion
// `FaultBoundary`/`FaultPlan` vocabulary is AB-95's (Backlog, out of scope
// here — see AB-255's "Out of scope" section): this slice only needs a
// shape for `CausalTraceEntry.faultEvidence` to compile against, so
// `FiredFault` is declared minimally, field-for-field with AB-92's sketch,
// ready for AB-95 to import instead of redefine once it lands.
// ---------------------------------------------------------------------------

/** See AB-92's Decision (2026-09-01), AC8. Never populated by this slice — no fault engine exists yet. */
export interface FiredFault {
  readonly plan: string;
  readonly boundary: string;
  readonly occurrence: number;
  readonly firedAt: string;
}

/**
 * A normalized, portable causal-trace entry (AB-92 AC8's `CausalTraceEntry`,
 * matched field for field). `owner` is left undefined by this slice — no
 * parent identity flows through the two-field `EventRecorderOwnerIdentity`
 * this recorder accepts; a future Bureau-level recorder (tst-03d) is what
 * populates cross-resource ownership.
 */
export interface CausalTraceEntry {
  readonly resource: string;
  readonly owner?: string;
  readonly revision: number;
  readonly event: string;
  readonly command?: string;
  readonly result?: unknown;
  readonly effect?: string;
  readonly cleanup?: CleanupAcknowledgement;
  readonly faultEvidence?: FiredFault;
  readonly causedBy?: readonly string[];
}

/** Identifies the resource an attached source represents — `resource = \`${kind}:${id}\`` on every entry it produces. */
export interface EventRecorderOwnerIdentity {
  readonly kind: string;
  readonly id: string;
}

/**
 * Minimal structural surface `EventRecorder.attach` needs from a source —
 * AB-92 AC8's `attach` signature, with one mechanical deviation from its
 * sketch: `TEventMap` carries no `extends Record<string, { type: string }>`
 * bound here. Every real event map this recorder attaches to
 * (`CombinedOperativeEventClassMap`, and `CombinedOperativeEventMap` itself)
 * is a plain interface with no index signature of its own — and a type
 * without an index signature is never assignable to a `Record<string, V>`-
 * constrained type parameter, as either an explicit type argument or a
 * default (verified against this TypeScript version). Requiring that bound
 * would make `attach` uninstantiable against its own package's event maps;
 * dropping it costs nothing here, since `keyof TEventMap`/`TEventMap[K]`
 * stay valid for indexed access on an unconstrained type parameter.
 */
export interface EventListenerSource<TEventMap> {
  addEventListener<K extends keyof TEventMap>(
    type: K,
    listener: (event: TEventMap[K]) => void,
  ): void;
}

/** Duck-typed removal surface: used when present (real `ActiveRun`/`TypedEventTarget` sources) so `attach`'s returned detach function stops future delivery at the source, not only inside the recorder. */
interface EventListenerRemovableSource<TEventMap> {
  removeEventListener<K extends keyof TEventMap>(
    type: K,
    listener: (event: TEventMap[K]) => void,
  ): void;
}

function isRemovableSource<TEventMap>(
  source: EventListenerSource<TEventMap>,
): source is EventListenerSource<TEventMap> & EventListenerRemovableSource<TEventMap> {
  return (
    typeof (source as Partial<EventListenerRemovableSource<TEventMap>>).removeEventListener ===
    'function'
  );
}

/**
 * Projects an arbitrary captured value into a plain, `JSON.stringify`-stable
 * shape: primitives, arrays, and plain objects (`Object.prototype` or `null`
 * prototype) recurse over their own enumerable properties; any other class
 * instance (a `Conversation`, a `RunResult`, an `AgentRunError`, ...)
 * collapses to `{ $kind: <constructor name> }` rather than being walked —
 * those carry their own internal identity/timing that would otherwise break
 * byte-identical normalized output across two independently constructed
 * runtimes, and this recorder's job is a causal trace, not a full-fidelity
 * payload replay. `Error` gets one special case (`{ name, message }`) since
 * it is by far the most common non-plain payload shape (`RunErrorEvent`,
 * `GenerateErrorEvent`, ...).
 */
function projectValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => projectValue(item));
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    const projected: Record<string, unknown> = {};
    // `value` is a plain object at this point (own-prototype check above); a
    // bracket-notation read over `Object.entries` is the boundary this
    // recorder crosses to reflect over an arbitrary captured payload.
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      projected[key] = projectValue(entry);
    }
    return projected;
  }
  return { $kind: value.constructor.name };
}

/** Projects a captured event's own enumerable instance properties (never the DOM `Event` prototype's `timeStamp`/`target`/etc — those are never own properties on an `Event` subclass instance). */
function projectEvent(event: { type: string }): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(event as unknown as Record<string, unknown>)) {
    if (key === 'type') continue;
    projected[key] = projectValue(entry);
  }
  return projected;
}

/** A UUID (`crypto.randomUUID()`) or a `RuntimeIdentifiers.next(kind)` value (`${kind}-${n}`) — the two shapes `RuntimeServices.identifiers` ever produces. */
const IDENTIFIER_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[a-z][a-zA-Z-]*-\d+$/;

/**
 * Rewrites every string produced by `RuntimeServices.identifiers` to its
 * logical first-seen sequence position (`identifier-1`, `identifier-2`,
 * ...), canonicalizing both shapes `IDENTIFIER_SHAPE` matches to the same
 * scheme regardless of which one a given `RuntimeServices` implementation
 * mints — so a real UUID and a manual runtime's `run-3` both normalize the
 * same way when they occupy the same position in capture order. A factory
 * function (not a class), matching this package's conventions — its only
 * state is the `seen` map, closed over rather than held on `this`.
 */
function createIdentifierNormalizer(): { rewrite(value: unknown): unknown } {
  const seen = new Map<string, string>();

  function rewrite(value: unknown): unknown {
    if (typeof value === 'string' && IDENTIFIER_SHAPE.test(value)) {
      let canonical = seen.get(value);
      if (canonical === undefined) {
        canonical = `identifier-${seen.size + 1}`;
        seen.set(value, canonical);
      }
      return canonical;
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => rewrite(item));
    }
    if (value !== null && typeof value === 'object' && value.constructor === Object) {
      const rewritten: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        rewritten[key] = rewrite(entry);
      }
      return rewritten;
    }
    return value;
  }

  return { rewrite };
}

function resourceKey(ownerIdentity: EventRecorderOwnerIdentity): string {
  return `${ownerIdentity.kind}:${ownerIdentity.id}`;
}

function entryId(resource: string, revision: number): string {
  return `${resource}#${revision}`;
}

/**
 * The deterministic event recorder (AB-92 AC8, AB-255). Subscribes through
 * a resource's own complete event-map type via `attach`/`attachIterable`
 * rather than a hand-maintained name list, normalizes every captured event
 * into `CausalTraceEntry` form against the injected `RuntimeServices`, and
 * supports exact-sequence and happens-before assertions over the result.
 */
export interface EventRecorder {
  /**
   * Subscribes through `source`'s complete event-map type. `eventTypes`
   * defaults to every `CombinedOperativeEventType`
   * (`COMBINED_OPERATIVE_EVENT_TYPES`) — the runtime-visible complete list —
   * when omitted; a caller observing a different `TEventMap` (a local
   * test-only event map, an armorer toolbox) supplies its own key list
   * explicitly. Type erasure is why this third parameter exists at all:
   * `attach`'s generic `TEventMap` cannot be enumerated at runtime from the
   * type alone, so the concrete key list has to come in from the caller
   * (defaulted for the common `CombinedOperativeEventMap` case) rather than
   * from a hand-maintained list inside this file.
   */
  attach<TEventMap>(
    source: EventListenerSource<TEventMap>,
    ownerIdentity: EventRecorderOwnerIdentity,
    eventTypes?: readonly Extract<keyof TEventMap, string>[],
  ): () => void;

  /**
   * Covers the second public run-handle shape (`AgentRun`/`DiagnosticAgentRun`),
   * which is `AsyncIterable<RunEvent>` with no listener registration surface
   * at all. Consumes the handle's only stream, so it cannot be combined with
   * a second observer on the same handle — `AgentRun`'s iterator is
   * single-consumer and throws `CompletedRunIterationError` on a second
   * independent iteration (`agent-run.ts:245`). A test needing two
   * independent observers on one run attaches to an `ActiveRun` instead,
   * which is the surface that supports it (see `attach`).
   *
   * The consuming loop is tracked on `RuntimeServices.deferred` so a leaked
   * iteration (never detached, source never completes) surfaces in a
   * `deferred.drain()` report instead of hanging silently.
   */
  attachIterable(
    source: AsyncIterable<RunEvent>,
    ownerIdentity: EventRecorderOwnerIdentity,
  ): () => void;

  /**
   * Every captured event, normalized: timestamps are expressed only as
   * `result.capturedAtOffsetMs`, an offset from this recorder's own
   * `RuntimeServices.clock` origin (the clock reading at construction) —
   * never as an absolute wall-clock value — and every identifier-shaped
   * string is rewritten to its first-seen logical sequence position.
   */
  normalize(): readonly CausalTraceEntry[];

  /**
   * Asserts an exact ordered event-type sequence for a single resource with
   * no concurrent children. Throws (naming the observed sequence) if more
   * than one resource has been captured — use `assertHappensBefore` for a
   * multi-resource trace, since a total order across concurrent resources
   * isn't a well-formed assertion.
   */
  assertSequence(expected: readonly string[]): void;

  /**
   * Asserts a partial-order edge through `CausalTraceEntry.causedBy`:
   * walks `after`'s entry backward through its `causedBy` chain looking for
   * `before`'s entry id. Never depends on wall-clock or capture order
   * directly — only on the recorded causal chain — so it holds under
   * either interleaving of two concurrent children as long as `before` and
   * `after` are on the same resource's chain.
   */
  assertHappensBefore(before: string, after: string): void;
}

/** Constructs an `EventRecorder` bound to `runtime`. A factory function (not a class) per this package's conventions — every value below is a closure-local `const`, not an instance field. */
export function createEventRecorder(runtime: RuntimeServices): EventRecorder {
  const origin = runtime.clock.now();
  const entries: CausalTraceEntry[] = [];
  const idNormalizer = createIdentifierNormalizer();
  const nextRevisionByResource = new Map<string, number>();
  const lastEntryIdByResource = new Map<string, string>();

  function capture(
    resource: string,
    ownerIdentity: EventRecorderOwnerIdentity,
    type: string,
    raw: { type: string },
  ): void {
    const revision = nextRevisionByResource.get(resource) ?? 0;
    nextRevisionByResource.set(resource, revision + 1);

    const capturedAtOffsetMs = runtime.clock.now() - origin;
    const projected = idNormalizer.rewrite(projectEvent(raw));

    const previousEntryId = lastEntryIdByResource.get(resource);
    const causedBy = previousEntryId === undefined ? undefined : [previousEntryId];

    const entry: CausalTraceEntry = {
      resource,
      revision,
      event: type,
      result: { ...(projected as Record<string, unknown>), capturedAtOffsetMs },
      ...(causedBy === undefined ? {} : { causedBy }),
    };
    // `owner` is deliberately never set (see `CausalTraceEntry`'s doc
    // comment); `ownerIdentity` is consulted only for `resource`.
    void ownerIdentity;

    entries.push(entry);
    lastEntryIdByResource.set(resource, entryId(resource, revision));
  }

  function attach<TEventMap>(
    source: EventListenerSource<TEventMap>,
    ownerIdentity: EventRecorderOwnerIdentity,
    eventTypes: readonly Extract<
      keyof TEventMap,
      string
    >[] = COMBINED_OPERATIVE_EVENT_TYPES as unknown as readonly Extract<keyof TEventMap, string>[],
  ): () => void {
    const resource = resourceKey(ownerIdentity);
    let disposed = false;

    const listeners = new Map<
      Extract<keyof TEventMap, string>,
      (event: TEventMap[keyof TEventMap]) => void
    >();
    for (const type of eventTypes) {
      const listener = (event: TEventMap[keyof TEventMap]): void => {
        if (disposed) return;
        // `event` is generically only known to be `TEventMap[keyof TEventMap]`
        // — `attach` carries no `{ type: string }` bound on `TEventMap` (see
        // the doc comment on `EventListenerSource`) — but every real
        // caller's event map values genuinely do carry `.type`; `capture`
        // needs that shape to skip it while projecting the rest of the
        // payload.
        capture(resource, ownerIdentity, type, event as unknown as { type: string });
      };
      listeners.set(type, listener);
      source.addEventListener(type, listener);
    }

    return () => {
      if (disposed) return;
      disposed = true;
      if (isRemovableSource(source)) {
        for (const [type, listener] of listeners) {
          source.removeEventListener(type, listener);
        }
      }
    };
  }

  function attachIterable(
    source: AsyncIterable<RunEvent>,
    ownerIdentity: EventRecorderOwnerIdentity,
  ): () => void {
    const resource = resourceKey(ownerIdentity);
    const iterator = source[Symbol.asyncIterator]();
    let stopped = false;

    const loop = (async (): Promise<void> => {
      for (;;) {
        const next = await iterator.next();
        if (stopped) return;
        if (next.done) return;
        capture(resource, ownerIdentity, next.value.type, next.value);
      }
    })();
    runtime.deferred.track(loop, `event-recorder:${resource}`);

    return () => {
      if (stopped) return;
      stopped = true;
      void iterator.return?.();
    };
  }

  function normalize(): readonly CausalTraceEntry[] {
    return [...entries];
  }

  function assertSequence(expected: readonly string[]): void {
    const resources = new Set(entries.map((entry) => entry.resource));
    if (resources.size > 1) {
      throw new Error(
        `assertSequence: recorder has captured ${resources.size} resources (${[...resources].join(', ')}); assertSequence only supports a single resource with no concurrent children — use assertHappensBefore instead.`,
      );
    }
    const observed = entries.map((entry) => entry.event);
    const matches =
      observed.length === expected.length &&
      observed.every((type, index) => type === expected[index]);
    if (!matches) {
      throw new Error(
        `assertSequence: expected [${expected.join(', ')}] but observed [${observed.join(', ')}]`,
      );
    }
  }

  /**
   * Resolves a lookup key to exactly one captured entry: first tries an
   * unqualified event-type match (unique across every captured resource);
   * if that is ambiguous or absent, tries the resource-qualified form
   * `${resource}:${event}` (`resource` already being `${kind}:${id}`) — the
   * form a multi-resource trace needs to disambiguate two children emitting
   * the same event type.
   */
  function resolve(key: string): CausalTraceEntry {
    const byType = entries.filter((entry) => entry.event === key);
    if (byType.length === 1) {
      const [entry] = byType;
      if (entry) return entry;
    }
    const qualified = entries.filter((entry) => `${entry.resource}:${entry.event}` === key);
    if (qualified.length === 1) {
      const [entry] = qualified;
      if (entry) return entry;
    }
    if (byType.length > 1 || qualified.length > 1) {
      throw new Error(
        `assertHappensBefore: "${key}" is ambiguous (matched ${Math.max(byType.length, qualified.length)} entries) — qualify with "\${resource}:\${event}".`,
      );
    }
    throw new Error(
      `assertHappensBefore: "${key}" did not match any captured entry. Captured: [${entries
        .map((entry) => `${entry.resource}:${entry.event}`)
        .join(', ')}]`,
    );
  }

  function assertHappensBefore(before: string, after: string): void {
    const beforeEntry = resolve(before);
    const afterEntry = resolve(after);
    const beforeId = entryId(beforeEntry.resource, beforeEntry.revision);

    const visited = new Set<string>();
    const queue: string[] = [entryId(afterEntry.resource, afterEntry.revision)];
    const byId = new Map(
      entries.map((entry) => [entryId(entry.resource, entry.revision), entry] as const),
    );

    while (queue.length > 0) {
      const currentId = queue.shift();
      if (currentId === undefined || visited.has(currentId)) continue;
      visited.add(currentId);
      if (currentId === beforeId) return;
      const current = byId.get(currentId);
      for (const causeId of current?.causedBy ?? []) {
        queue.push(causeId);
      }
    }

    throw new Error(
      `assertHappensBefore: no causal path from "${before}" to "${after}" — observed causedBy chain for "${after}" never reaches "${before}".`,
    );
  }

  return { attach, attachIterable, normalize, assertSequence, assertHappensBefore };
}

export type { CombinedOperativeEventType };
