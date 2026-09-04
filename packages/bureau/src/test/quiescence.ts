/**
 * `BureauQuiescenceReport` / `assertBureauQuiescent` — AB-262's slice of
 * AB-92's Decision (2026-09-01), "Resource scope and quiescence report"
 * (AC4), narrowed to Bureau's own owned-work rows on top of AB-256's
 * `QuiescenceReport` (`@lostgradient/operative/test`).
 *
 * `assertBureauQuiescent(harness)` reads every row from a surface a
 * production caller can also read, and always calls `harness.bureau.shutdown()`
 * (AB-207) as part of resolving the report — a Bureau ownership-tree
 * quiescence check is meaningless without asking Bureau to actually wind
 * down. `activeDescendants`, `pendingWebhookDeliveries`, and
 * `durableAttempts` are read BEFORE `shutdown()` runs — `shutdown()`'s own
 * unconditional teardown disposes the durable engine and the raw `Storage`
 * handle those two reads depend on, so reading them after would be asking
 * an already-torn-down backend (see the in-code comment at that read for
 * the full reasoning). `activeRoots` and any registered timer/listener
 * leak are read AFTER `shutdown()`, through `harness.scope.close()`, which
 * needs `shutdown()`'s abort to have already happened to settle promptly.
 * `incomplete` is read straight off the `BureauShutdownReport`
 * `shutdown()` itself returns.
 *
 * - `activeRoots` / a registered timer or listener leak — `harness.scope`
 *   (AB-256's `ResourceScope`, over `RuntimeServices.deferred`/`timers`
 *   tracking and `AgentRun.closed()` acknowledgements). Every `startRun`
 *   root registers onto this scope automatically; a test registers a raw
 *   timer or listener directly to exercise those two leak kinds.
 * - `activeDescendants` — `harness.childRegistry.children()` (AB-50), the
 *   registry every `startChild` dispatch registers into by default.
 * - `pendingWebhookDeliveries` — `webhookNotifier.listDeliveries()`
 *   (AB-21), status `'pending'`.
 * - `durableAttempts` (the non-detached case) — `bureau.getDurableRun`
 *   (AB-207/AB-29) for every id a test registered via
 *   `harness.registerDurableRun`, when its `WorkflowState.status` is not
 *   yet terminal.
 * - `incomplete` — the `BureauShutdownReport` `shutdown()` itself just
 *   produced (AB-207): any owner it classified `'unresolved'` (a bounded
 *   `timeoutMilliseconds` wait elapsed before that owner's drain settled).
 *
 * `discoveredVia` reading: every row sourced from `harness.scope` carries
 * whatever `discoveredVia` AB-256's own evaluator assigned. Every other
 * row here — `listDeliveries()`, `getDurableRun` — is `'public-snapshot'`:
 * each is an async READ of a publicly-typed snapshot value, exactly the
 * discovery AB-256 declared but left unproduced on its own baseline (see
 * `resource-scope.ts`'s doc comment on that gap).
 *
 * Two rows stay permanently empty on this baseline (AB-322, narrowing the
 * five inherited from AB-262): no public listing exists yet for either.
 *
 * - `parkedWaits` — no public per-signal-wait listing exists; a run's own
 *   `snapshot().status === 'waiting'` is visible per-run but there is no
 *   registry enumerating every outstanding wait the way `ChildRunRegistry`
 *   enumerates children. AB-35 (Backlog) is the gap; this stays empty
 *   until a public listing lands.
 * - `pendingHookEffects` — AB-92's own inventory: "hooks resolve to a new
 *   gap (the seam exists but is unwired)". There is no hook-effect
 *   identity or tracking surface yet (AB-35, Backlog); this stays empty
 *   for the same reason as `parkedWaits`.
 *
 * The other four (`runningScheduleFires`, `activeEvaluations`,
 * `pendingAuditWrites`, `openStorageResources`) were ALSO permanently
 * empty on AB-262's baseline, on the argument that an UNBOUNDED
 * `shutdown()` awaits each owner's real drain as part of `ownerDrains`
 * (`settleOwner('scheduler', ...)` awaits `scheduler.stop()`, which
 * itself awaits every running task's result; `settleOwner('online-evals',
 * () => onlineEvalSampler.dispose())` awaits `Promise.allSettled([
 * ...activeEvaluations])`; `audit-trail.ts`'s `dispose()` awaits
 * `Promise.allSettled([...activeWrites])`), so nothing genuinely
 * in-flight ever survived to be read: a hung task made the unbounded call
 * hang right along with it, and a BOUNDED (`timeoutMilliseconds`) call's
 * still-draining owner was already visible under `incomplete` — no fault
 * plan existed yet (AB-95/AB-265) to force a genuine leftover past a
 * bounded wait and PROVE the argument, so the rows stayed unpopulated
 * rather than approximated.
 *
 * AB-265's fault engine changes this: `createFaultEngine(...).wrapGenerate`/
 * `.wrapStorage` can block a schedule fire's model call or a `kv.set` write
 * (an audit write, or — this is the part that took a second design pass,
 * see the test file — an evaluation's OWN audit-record write, never the
 * judge's own generate call: `online-evals.ts`'s `evaluateRun` races EVERY
 * judge call against the SAME background-shutdown `AbortSignal`
 * `bureau.shutdown()` fires, so a judge blocked on its own generate call is
 * untracked the instant that signal aborts, regardless of whether the call
 * itself ever settles — never observable past shutdown that way. Blocking
 * `recordScore`'s write instead, which is NOT raced against that signal,
 * keeps the evaluation genuinely in flight) — deterministically, past a
 * bounded `shutdown({ timeoutMilliseconds })` — so these four rows are now
 * populated from a REAL public snapshot read once `bureau.shutdown()`
 * returns, whether or not anything is actually still running (the common
 * case: nothing is, and every row below reads empty):
 *
 * - `runningScheduleFires` — `bureau.scheduler.getState().activeTask`
 *   (public: the same read `create-bureau.ts` itself uses to report
 *   `'scheduler.state'`). `scheduler.stop()`'s own `running` map entry for
 *   a still-executing task is not deleted until the task's dispatch
 *   completion path runs, so `getState()` keeps reporting it live for the
 *   whole window a bounded `shutdown()` raced past.
 * - `activeEvaluations` — `bureau.onlineEvalSampler.activeEvaluationSnapshots()`,
 *   already documented as "every evaluation currently in flight" — read
 *   AFTER `shutdown()` returns, so an evaluation blocked on its own
 *   audit-record write (see above) past the bounded wait is still in this
 *   list: `endTrackedEvaluation` — the only thing that removes it — runs
 *   in `runTrackedEvaluation`'s `.finally()`, which cannot run until
 *   `evaluateRun` itself returns, and it cannot return past a write that
 *   never settles.
 * - `pendingAuditWrites` — `harness.runtime.outstandingDeferred()`
 *   (`ManualRuntimeServices`' own public, NON-destructive peek — never
 *   `deferred.drain()`, which is destructive and would race the fault
 *   engine's own `after-sequence` bookkeeping), filtered to the
 *   `'audit-write'` label `audit-trail.ts` itself tracks every write
 *   under (AB-260). A blocked `kv.set()` never settles, so its label
 *   stays outstanding for as long as the block holds.
 * - `openStorageResources` — the storage fixture's OWN public handle
 *   accounting (`BureauStorageFixture.openHandles()`, AB-322): a call the
 *   fixture's wrapped `Storage` instance has started but not yet
 *   finished. Unlike the other three, this is not shadowed by any
 *   `BureauShutdownReport` owner — `bureau.shutdown()` tracks no
 *   "raw storage call" owner at all — so a lingering handle here is the
 *   ONLY place this leak is ever reported, and (unlike the other three
 *   rows) it IS folded into `leaked`/`quiescent` below.
 *
 * `runningScheduleFires`/`activeEvaluations`/`pendingAuditWrites` are
 * deliberately NOT folded into `leaked`: the owner each names
 * (`scheduler`/`online-evals`/`audit-trail`) is already reported under
 * `incomplete` when a bounded `shutdown()` times out on it — promoting
 * these into `leaked` too would report the identical bounded-shutdown-
 * timeout fact under two different report fields for the same root
 * cause, exactly the double-count AB-262's original design avoided by
 * leaving them empty. Populating them now is strictly more informative
 * (naming the specific resource, not just the owner) without changing
 * `quiescent`.
 */

import {
  type LeakedResource,
  QuiescenceError,
  type QuiescenceReport,
} from '@lostgradient/operative/test';

import type { AgentDefinitions } from '../agent-catalog';
import type { BureauShutdownOptions, BureauShutdownReport } from '../types';
import type { BureauTestHarness } from './harness';

/** One shutdown owner Bureau itself reported as `'unresolved'` — a bounded `timeoutMilliseconds` wait elapsed before its drain settled. */
export interface BureauIncompleteWork {
  readonly kind: string;
  readonly id?: string;
  /** The shutdown report's own outcome for this owner — always `'unresolved'` today (AB-207 has no other incomplete outcome). */
  readonly reason: string;
}

/**
 * Bureau's quiescence report — AB-256's `QuiescenceReport` shape
 * (`scope`, `quiescent`, `leaked`, `detached`) plus the Bureau-owned rows
 * AB-262 adds. `leaked` is the union of every row below (and whatever
 * `harness.scope` itself found leaked); `quiescent` is `true` only when
 * `leaked` is empty — `incomplete` work is reported but never promoted
 * into `leaked` (see the module doc).
 */
export interface BureauQuiescenceReport {
  readonly scope: string;
  readonly quiescent: boolean;
  readonly leaked: readonly LeakedResource[];
  readonly detached: readonly { readonly kind: string; readonly id: string }[];
  readonly activeRoots: readonly LeakedResource[];
  readonly activeDescendants: readonly LeakedResource[];
  readonly runningScheduleFires: readonly LeakedResource[];
  readonly parkedWaits: readonly LeakedResource[];
  readonly pendingHookEffects: readonly LeakedResource[];
  readonly pendingAuditWrites: readonly LeakedResource[];
  readonly activeEvaluations: readonly LeakedResource[];
  readonly pendingWebhookDeliveries: readonly LeakedResource[];
  readonly openStorageResources: readonly LeakedResource[];
  readonly durableAttempts: readonly LeakedResource[];
  /** Owners `bureau.shutdown()` itself classified `'unresolved'` — see the module doc's "incomplete" distinction. */
  readonly incomplete: readonly BureauIncompleteWork[];
  /** The `BureauShutdownReport` `assertBureauQuiescent` awaited to build this report — kept for reproduction-artifact assembly (AB-263). */
  readonly shutdownReport: BureauShutdownReport;
}

const NAMED_ROWS = [
  'activeRoots',
  'activeDescendants',
  'runningScheduleFires',
  'parkedWaits',
  'pendingHookEffects',
  'pendingAuditWrites',
  'activeEvaluations',
  'pendingWebhookDeliveries',
  'openStorageResources',
  'durableAttempts',
] as const;

function renderLeak(leak: LeakedResource): string {
  return (
    `  - ${leak.kind} "${leak.identifier}"` +
    (leak.owner ? ` (owner: ${leak.owner})` : '') +
    (leak.parentId ? ` (parent: ${leak.parentId})` : '') +
    ` — discovered via ${leak.discoveredVia}`
  );
}

function renderReport(report: BureauQuiescenceReport): string {
  const lines = [`Bureau harness "${report.scope}" is not quiescent:`];
  const named = new Set<LeakedResource>();
  for (const key of NAMED_ROWS) {
    const row = report[key];
    if (row.length === 0) continue;
    lines.push(`${key}:`);
    for (const leak of row) {
      lines.push(renderLeak(leak));
      named.add(leak);
    }
  }
  // A `timer`/`listener` leak lives only in `harness.scope`'s own report —
  // folded into `leaked` above, but not one of the ten Bureau-specific
  // named rows (none of them is "timer" or "listener"; only a registered
  // `'run'` resource's leak is re-surfaced, as `activeRoots`). Render it
  // here so the error message still names every non-empty row, per this
  // issue's own acceptance criterion.
  const other = report.leaked.filter((leak) => !named.has(leak));
  if (other.length > 0) {
    lines.push('other leaked resource(s):');
    for (const leak of other) lines.push(renderLeak(leak));
  }
  if (report.incomplete.length > 0) {
    lines.push(
      `Incomplete (bounded shutdown wait elapsed, not counted as leaks): ${report.incomplete
        .map((entry) => `${entry.kind}${entry.id ? ` "${entry.id}"` : ''} (${entry.reason})`)
        .join(', ')}`,
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

/** A non-quiescent `close()` rejects with this — `report` carries the full structured detail. */
export class BureauQuiescenceError extends Error {
  readonly report: BureauQuiescenceReport;

  constructor(report: BureauQuiescenceReport) {
    super(renderReport(report));
    this.name = 'BureauQuiescenceError';
    this.report = report;
  }
}

function isNonTerminalWorkflowStatus(status: string): boolean {
  return status === 'pending' || status === 'running' || status === 'suspended';
}

/**
 * Builds Bureau's quiescence report. Calls `harness.bureau.shutdown()`
 * (AB-207) — optionally with `shutdownOptions` (e.g. `{timeoutMilliseconds}`
 * to exercise the `incomplete` classification deterministically) — then
 * reads every row from the public surfaces the module doc names. Bureau's
 * own `shutdown()` is idempotent, so calling this more than once against
 * the same harness never shuts down twice; `BureauTestHarness.close()`
 * builds on this rather than duplicating it.
 */
export async function assertBureauQuiescent<D extends AgentDefinitions = AgentDefinitions>(
  harness: BureauTestHarness<D>,
  shutdownOptions?: BureauShutdownOptions,
): Promise<BureauQuiescenceReport> {
  const { bureau } = harness;

  // These four rows are read BEFORE `bureau.shutdown()` runs, deliberately:
  // `shutdown()`'s unconditional teardown disposes the durable engine and
  // the raw `Storage` handle it wraps (`create-bureau.ts`'s `finally`
  // block) — a `listDeliveries()`/`getDurableRun` read AFTER that point
  // would be asking an already-torn-down backend. Neither row is a thing
  // `shutdown()` itself drains anyway (that is exactly what makes a
  // leftover here a genuine LEAK rather than something `incomplete`
  // already covers): a KV-persisted webhook delivery `webhookNotifier`
  // never claimed into its own live tracking, and a durable run this
  // harness never captured a process-local handle for. Reading their
  // CURRENT public state right as quiescence is asked for — before
  // shutdown can touch anything — is what "still outstanding" means for a
  // thing Bureau does not own the draining of.
  const activeDescendants: LeakedResource[] = harness.childRegistry
    .children()
    .filter((descriptor) => descriptor.status === 'running')
    .map((descriptor) => ({
      kind: 'child',
      identifier: descriptor.id,
      parentId: descriptor.parentId,
      discoveredVia: 'public-child-discovery',
    }));

  const pendingWebhookDeliveries: LeakedResource[] = [];
  const deliveries = (await bureau.webhookNotifier?.listDeliveries()) ?? [];
  for (const delivery of deliveries) {
    if (delivery.status !== 'pending') continue;
    pendingWebhookDeliveries.push({
      kind: 'queue-item',
      identifier: delivery.id,
      owner: delivery.runId,
      discoveredVia: 'public-snapshot',
    });
  }

  const durableAttempts: LeakedResource[] = [];
  const detachedDurable: { readonly kind: string; readonly id: string }[] = [];
  for (const registration of harness.durableRegistrations) {
    const state = await bureau.getDurableRun(registration.runId);
    if (registration.detached) {
      detachedDurable.push({ kind: 'durable-owner', id: registration.runId });
      continue;
    }
    if (state && isNonTerminalWorkflowStatus(state.status)) {
      durableAttempts.push({
        kind: 'durable-owner',
        identifier: registration.runId,
        discoveredVia: 'public-snapshot',
      });
    }
  }

  const shutdownReport = await bureau.shutdown(shutdownOptions);

  // Read AFTER `shutdown()` returns (AB-322): a bounded call races a
  // still-draining owner's real work via `Promise.race` (`create-bureau.ts`'s
  // `shutdown()`), so the moment this call resolves is exactly when a
  // fault-forced leftover (AB-265's engine blocking a schedule fire, an
  // audit write, or an evaluation's judge call) is still genuinely live on
  // each public surface below — see the module doc for why each is (or is
  // not) folded into `leaked`.
  const runningScheduleFires: LeakedResource[] = [];
  const activeTask = bureau.scheduler?.getState().activeTask;
  if (activeTask) {
    runningScheduleFires.push({
      kind: 'queue-item',
      identifier: activeTask.id,
      owner: activeTask.priority,
      discoveredVia: 'public-snapshot',
    });
  }

  const activeEvaluations: LeakedResource[] = (
    bureau.onlineEvalSampler?.activeEvaluationSnapshots() ?? []
  ).map((snapshot) => ({
    kind: 'queue-item',
    identifier: snapshot.id,
    ...(snapshot.owner !== undefined ? { owner: snapshot.owner } : {}),
    discoveredVia: 'public-snapshot',
  }));

  const pendingAuditWrites: LeakedResource[] = harness.runtime
    .outstandingDeferred()
    .filter((label) => label === 'audit-write')
    .map((label, index) => ({
      kind: 'queue-item',
      identifier: `${label}#${index + 1}`,
      owner: 'audit-trail',
      discoveredVia: 'runtime-services-deferred',
    }));

  const openStorageResources: LeakedResource[] = harness.storage.openHandles().map((handle) => ({
    kind: 'queue-item',
    identifier: handle,
    owner: 'storage',
    discoveredVia: 'public-snapshot',
  }));

  // `close()`, never `assertQuiescent()`: by this point `bureau.shutdown()`
  // has already aborted every run it owns, so a REAL, unbounded
  // `run.closed()` settles promptly either way (the run finished cleanly
  // long ago, or it was just aborted). `assertQuiescent()`'s own probe
  // deliberately forces an ALREADY-ABORTED signal onto `closed()` to stay
  // non-destructive — correct for AB-256's own use, but a `bureau.run()`
  // catalog dispatch's wrapper handle (`createDeferredAgentRun`, AB-292)
  // unconditionally disqualifies ITS OWN fast path the instant its
  // underlying run exists, so an artificially-pre-aborted probe on that
  // wrapper reports `unresolved`/`timed-out` even for a run that settled
  // cleanly seconds ago — a false leak. `scope.close()` sidesteps this by
  // awaiting the real settlement instead of racing a synthetic signal.
  let scopeReport: QuiescenceReport;
  try {
    scopeReport = await harness.scope.close();
  } catch (error) {
    if (!(error instanceof QuiescenceError)) throw error;
    scopeReport = error.report;
  }
  const activeRoots = scopeReport.leaked.filter((leak) => leak.kind === 'durable-owner');

  const incomplete: BureauIncompleteWork[] = [];
  for (const owner of shutdownReport.owners) {
    if (owner.outcome === 'unresolved') {
      incomplete.push({ kind: owner.kind, id: owner.id, reason: owner.outcome });
    }
  }

  // `openStorageResources` is folded in (see the module doc); the other
  // three fault-forced rows above are deliberately NOT — their owner is
  // already named under `incomplete`.
  const leaked: LeakedResource[] = [
    ...scopeReport.leaked,
    ...activeDescendants,
    ...pendingWebhookDeliveries,
    ...durableAttempts,
    ...openStorageResources,
  ];

  const detached = [...scopeReport.detached, ...detachedDurable];

  return {
    scope: scopeReport.scope,
    quiescent: leaked.length === 0,
    leaked,
    detached,
    activeRoots,
    activeDescendants,
    runningScheduleFires,
    parkedWaits: [],
    pendingHookEffects: [],
    pendingAuditWrites,
    activeEvaluations,
    pendingWebhookDeliveries,
    openStorageResources,
    durableAttempts,
    incomplete,
    shutdownReport,
  };
}
