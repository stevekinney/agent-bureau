/**
 * `ResourceScope` / `QuiescenceReport` — AB-92's Decision (2026-09-01),
 * "Resource scope and quiescence report" (AC4), implemented per AB-256's
 * acceptance criteria and AB-204's `closed()` cleanup-acknowledgement
 * vocabulary.
 *
 * A `ResourceScope` is a test-owned bookkeeping surface: a test registers
 * every run, subscription, timer, and deferred-queue item it expects to
 * become quiescent by the end of the test, then calls `close()` (or the
 * non-mutating `assertQuiescent()`) to prove nothing it owns is still
 * live. Every leak `close()`/`assertQuiescent()` reports is discovered
 * through a surface a production caller can also read — `RuntimeServices`'
 * own tracking (`timers`, `deferred`), `ActiveRun.closed()` /
 * `AgentRun.closed()` (AB-204's `CleanupAcknowledgement`), a
 * `ChildRunRegistry`'s public `children()` listing, or a `Subscription`'s
 * public `closed` getter — never a private counter this module invents.
 *
 * `discoveredVia` reading, spelled out because the union is closed to five
 * values and this slice produces more than three kinds of leak:
 *
 * - `'runtime-services-timers'` — a registered timer handle still present
 *   in `RuntimeServices`' own pending-timer bookkeeping.
 * - `'runtime-services-deferred'` — a registered deferred-queue label still
 *   outstanding after `RuntimeServices.deferred.drain()`.
 * - `'public-child-discovery'` — used both for its literal case (a
 *   `ChildRunRegistry` entry still `'running'`) AND, by extension, for a
 *   registered run or subscription found live: a `ResourceScope`'s own
 *   registration list is itself a public child listing (the caller handed
 *   this scope the exact same `run`/`subscription` object a production
 *   caller holds), and each entry's own public read surface — `closed()`'s
 *   settlement, `Subscription.closed` — is the evidence, exactly as
 *   `ChildRunRegistry.children()` is for a dispatched child. No dedicated
 *   `discoveredVia` value exists for "registered run" or "registered
 *   listener" in AB-256's closed union, so both share this one rather than
 *   inventing a sixth value the type doesn't declare.
 * - `'public-snapshot'` — declared on the union but never produced by this
 *   slice: `snapshot()` does not exist on the baseline. Reachable once
 *   AB-214 lands.
 * - `'public-connection-listing'` — gateway-scoped (tst-07a), out of this
 *   slice's boundary; the `'connection'` `LeakedResourceKind` is likewise
 *   declared but never produced here.
 *
 * A leaked, registered *run* is reported under `LeakedResourceKind`
 * `'durable-owner'` (not `'run'` — that string is not a member of the
 * kind union at all): the run is the owner of cleanup work that has not
 * yet been acknowledged.
 */

import type {
  ManualRuntimeServices,
  RuntimeServices,
  RuntimeTimeoutHandle,
  Subscription,
} from 'lifecycle';

import type { ChildRunRegistry } from '../child-run';
import type { CleanupAcknowledgement, ClosedOptions } from '../types';

/** The kind of resource a leaked entry describes. */
export type LeakedResourceKind =
  'child' | 'timer' | 'listener' | 'queue-item' | 'durable-owner' | 'connection';

/** How a leak was discovered — always a surface a production caller can also read. */
export type LeakedResourceDiscoveredVia =
  | 'runtime-services-deferred'
  | 'runtime-services-timers'
  | 'public-snapshot'
  | 'public-child-discovery'
  | 'public-connection-listing';

/** One resource `close()`/`assertQuiescent()` found still live. */
export interface LeakedResource {
  readonly kind: LeakedResourceKind;
  readonly identifier: string;
  readonly owner?: string;
  readonly parentId?: string;
  readonly discoveredVia: LeakedResourceDiscoveredVia;
}

/** A resource this scope was told about but does not expect to clean up itself. */
export interface DetachedResource {
  readonly kind: string;
  readonly id: string;
}

/** The result of asking a `ResourceScope` whether everything it owns has settled. */
export interface QuiescenceReport {
  readonly scope: string;
  readonly quiescent: boolean;
  readonly leaked: readonly LeakedResource[];
  readonly detached: readonly DetachedResource[];
}

/**
 * The minimal surface a registered "run" resource must expose — satisfied
 * by `ActiveRun`, `AgentRun`, and `DiagnosticAgentRun` alike (AB-204).
 */
export interface ClosableRun {
  abort(reason?: string): void;
  closed(options?: ClosedOptions): Promise<CleanupAcknowledgement>;
}

interface RegisterRunResource {
  readonly kind: 'run';
  readonly identifier: string;
  readonly owner?: string;
  readonly parentId?: string;
  readonly run: ClosableRun;
  readonly detached?: boolean;
}

interface RegisterTimerResource {
  readonly kind: 'timer';
  readonly identifier: string;
  readonly owner?: string;
  readonly parentId?: string;
  readonly handle: RuntimeTimeoutHandle;
  readonly detached?: boolean;
}

interface RegisterListenerResource {
  readonly kind: 'listener';
  readonly identifier: string;
  readonly owner?: string;
  readonly parentId?: string;
  readonly subscription: Subscription;
  readonly detached?: boolean;
}

interface RegisterQueueItemResource {
  readonly kind: 'queue-item';
  readonly identifier: string;
  readonly owner?: string;
  readonly parentId?: string;
  /** The exact `label` this item was tracked under via `RuntimeServices.deferred.track()`. */
  readonly label: string;
  readonly detached?: boolean;
}

interface RegisterChildResource {
  readonly kind: 'child';
  readonly identifier: string;
  readonly owner?: string;
  readonly parentId?: string;
  readonly registry: ChildRunRegistry;
  readonly detached?: boolean;
}

/**
 * A resource `ResourceScope.register()` accepts. `'run'` covers a barrier
 * or any other started-work handle sharing `ClosableRun`'s shape — the
 * AB-92 sketch's "runs, subscriptions, timers, and barriers" collapse onto
 * these five registration kinds, since a barrier is, from this scope's
 * point of view, just another `ClosableRun`.
 */
export type RegisterableResource =
  | RegisterRunResource
  | RegisterTimerResource
  | RegisterListenerResource
  | RegisterQueueItemResource
  | RegisterChildResource;

/** A non-quiescent `close()` rejects with this — `report` carries the full structured detail. */
export class QuiescenceError extends Error {
  readonly report: QuiescenceReport;

  constructor(report: QuiescenceReport) {
    super(renderReport(report));
    this.name = 'QuiescenceError';
    this.report = report;
  }
}

function renderReport(report: QuiescenceReport): string {
  const lines = [`ResourceScope "${report.scope}" is not quiescent:`];
  for (const leak of report.leaked) {
    lines.push(
      `  - ${leak.kind} "${leak.identifier}"` +
        (leak.owner ? ` (owner: ${leak.owner})` : '') +
        (leak.parentId ? ` (parent: ${leak.parentId})` : '') +
        ` — discovered via ${leak.discoveredVia}`,
    );
  }
  if (report.detached.length > 0) {
    lines.push(
      `Detached (not counted as leaks): ${report.detached
        .map((entry) => `${entry.kind} "${entry.id}"`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** Structural guard: does this `RuntimeServices` also expose `ManualRuntimeServices.pendingTimers()`? */
function hasTimerIntrospection(
  runtime: RuntimeServices,
): runtime is RuntimeServices & Pick<ManualRuntimeServices, 'pendingTimers'> {
  return (
    'pendingTimers' in runtime &&
    typeof (runtime as Partial<ManualRuntimeServices>).pendingTimers === 'function'
  );
}

interface ScopeNode {
  readonly label: string;
  readonly registrations: RegisterableResource[];
  readonly children: ScopeNode[];
}

function createNode(label: string): ScopeNode {
  return { label, registrations: [], children: [] };
}

/**
 * A resource paired with the label of the scope it was registered on — the
 * default `owner` for any leak it produces, per the AC's nested-scope
 * attribution rule: a leak registered on a child scope is reported at
 * whichever ancestor's `close()`/`assertQuiescent()` is called, with the
 * child scope's label as that leak's `owner`, unless the registration
 * supplied its own explicit `owner`.
 */
interface OwnedResource {
  readonly resource: RegisterableResource;
  readonly scopeLabel: string;
}

/** Every registration in this node and all of its descendants, deepest-first order irrelevant. */
function collectRegistrations(node: ScopeNode): OwnedResource[] {
  const collected: OwnedResource[] = node.registrations.map((resource) => ({
    resource,
    scopeLabel: node.label,
  }));
  for (const child of node.children) {
    collected.push(...collectRegistrations(child));
  }
  return collected;
}

function isTerminalAcknowledgement(acknowledgement: CleanupAcknowledgement): boolean {
  return acknowledgement.status === 'completed' || acknowledgement.status === 'not-required';
}

/**
 * Probes a registered run's cleanup status without aborting it: an
 * already-aborted signal never overrides a genuinely cached settlement
 * (`closed-acknowledgement.ts` checks the cache before the signal), so this
 * returns the real acknowledgement for a settled run and `{ status:
 * 'unresolved', reason: 'timed-out' }` — correctly read as "still live" —
 * for one that has not settled yet, all without calling `abort()`.
 */
async function probeRunAcknowledgement(run: ClosableRun): Promise<CleanupAcknowledgement> {
  const controller = new AbortController();
  controller.abort();
  return run.closed({ signal: controller.signal });
}

async function evaluateResources(
  scopeLabel: string,
  ownedResources: OwnedResource[],
  runtime: RuntimeServices,
  resolveRun: (run: ClosableRun) => Promise<CleanupAcknowledgement>,
): Promise<QuiescenceReport> {
  const leaked: LeakedResource[] = [];
  const detached: DetachedResource[] = [];

  const timerHandles = hasTimerIntrospection(runtime)
    ? new Set(runtime.pendingTimers().map((entry) => entry.handle))
    : undefined;
  const drainReport = await runtime.deferred.drain();
  const deferredOutstanding = new Set(drainReport.outstanding);

  for (const owned of ownedResources) {
    const { resource } = owned;
    // Every leak's default `owner` is the label of the scope this resource
    // was registered on, so a leak registered on a child scope still names
    // that child at an ancestor's `close()`/`assertQuiescent()` — unless
    // the registration supplied its own explicit `owner`.
    const owner = resource.owner ?? owned.scopeLabel;

    if (resource.detached) {
      detached.push({ kind: resource.kind, id: resource.identifier });
      continue;
    }

    switch (resource.kind) {
      case 'run': {
        const acknowledgement = await resolveRun(resource.run);
        if (!isTerminalAcknowledgement(acknowledgement)) {
          leaked.push({
            kind: 'durable-owner',
            identifier: resource.identifier,
            owner,
            parentId: resource.parentId,
            discoveredVia: 'public-child-discovery',
          });
        }
        break;
      }
      case 'timer': {
        // Timer introspection is a `ManualRuntimeServices` extension, not
        // part of the `RuntimeServices` contract itself — a runtime that
        // doesn't expose `pendingTimers()` (the real-globals default)
        // leaves a registered timer unverifiable rather than falsely
        // reported either way.
        if (timerHandles?.has(resource.handle)) {
          leaked.push({
            kind: 'timer',
            identifier: resource.identifier,
            owner,
            parentId: resource.parentId,
            discoveredVia: 'runtime-services-timers',
          });
        }
        break;
      }
      case 'listener': {
        if (!resource.subscription.closed) {
          leaked.push({
            kind: 'listener',
            identifier: resource.identifier,
            owner,
            parentId: resource.parentId,
            discoveredVia: 'public-child-discovery',
          });
        }
        break;
      }
      case 'queue-item': {
        if (deferredOutstanding.has(resource.label)) {
          leaked.push({
            kind: 'queue-item',
            identifier: resource.identifier,
            owner,
            parentId: resource.parentId,
            discoveredVia: 'runtime-services-deferred',
          });
        }
        break;
      }
      case 'child': {
        for (const descriptor of resource.registry.children()) {
          if (descriptor.status !== 'running') continue;
          leaked.push({
            kind: 'child',
            identifier: descriptor.id,
            owner,
            parentId: descriptor.parentId,
            discoveredVia: 'public-child-discovery',
          });
        }
        break;
      }
      /* c8 ignore next -- exhaustiveness guard; every RegisterableResource kind is handled above */
      default: {
        const exhaustive: never = resource;
        throw new Error(`resource-scope: unhandled resource kind ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return { scope: scopeLabel, quiescent: leaked.length === 0, leaked, detached };
}

/**
 * A test-owned bookkeeping scope over runs, subscriptions, timers, and
 * deferred-queue items. `createResourceScope(label, runtime)` creates the
 * root; `child(label)` nests a scope sharing the same `runtime` — a leak
 * registered on a child is reported at whichever ancestor's `close()` or
 * `assertQuiescent()` is called, with the child's label as that leak's
 * `owner` unless the registration supplied its own.
 */
export interface ResourceScope {
  /** Records a resource this scope expects to become quiescent. */
  register(resource: RegisterableResource): void;
  /** Creates a nested scope sharing this scope's `runtime`. */
  child(label: string): ResourceScope;
  /**
   * Reports the live state of this scope and every descendant without
   * aborting anything — safe to call before, instead of, or repeatedly
   * around `close()`.
   */
  assertQuiescent(): Promise<QuiescenceReport>;
  /**
   * Aborts every registered run in this scope and its descendants, awaits
   * each one's real `closed()` settlement, then resolves with the
   * resulting report — or rejects with a {@link QuiescenceError} carrying
   * that report if anything remained live. Idempotent: a second call
   * returns (or rethrows) the exact same outcome without aborting or
   * awaiting anything a second time.
   */
  close(): Promise<QuiescenceReport>;
}

/**
 * Creates the root of a `ResourceScope` tree. `runtime` is the same
 * `RuntimeServices` instance the code under test was composed with —
 * `resource-scope.ts` never constructs its own.
 */
export function createResourceScope(label: string, runtime: RuntimeServices): ResourceScope {
  function wrap(node: ScopeNode): ResourceScope {
    let closePromise: Promise<QuiescenceReport> | undefined;

    return {
      register(resource) {
        node.registrations.push(resource);
      },
      child(childLabel) {
        const childNode = createNode(childLabel);
        node.children.push(childNode);
        return wrap(childNode);
      },
      async assertQuiescent() {
        return evaluateResources(node.label, collectRegistrations(node), runtime, (run) =>
          probeRunAcknowledgement(run),
        );
      },
      close() {
        if (!closePromise) {
          closePromise = (async () => {
            const resources = collectRegistrations(node);
            for (const { resource } of resources) {
              if (resource.kind === 'run' && !resource.detached) {
                resource.run.abort();
              }
            }
            const report = await evaluateResources(node.label, resources, runtime, (run) =>
              run.closed(),
            );
            if (!report.quiescent) {
              throw new QuiescenceError(report);
            }
            return report;
          })();
        }
        return closePromise;
      },
    };
  }

  return wrap(createNode(label));
}
