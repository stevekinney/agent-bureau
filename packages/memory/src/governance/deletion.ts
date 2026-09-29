import type { Embedder } from '@lostgradient/embeddings';

import {
  type MemoryRecordReference,
  MemoryRecordVersionConflictError,
} from '../memory-record-storage';
import type { GovernanceContext, ResolvedRecord } from './governance-context';
import type {
  MemoryDeletionPropagationResult,
  MemoryDeletionPropagator,
} from './governed-memory-types';
import {
  ASYNCHRONOUS_DELETION_TARGETS,
  type AsynchronousDeletionTarget,
  type MemoryDeletionPlan,
  type MemoryDeletionReceipt,
  type MemoryDeletionTarget,
  type MemoryDeletionTargetReceipt,
  type MemoryLineageLink,
  SYNCHRONOUS_DELETION_TARGETS,
  type SynchronousDeletionTarget,
} from './ledger-types';
import { resolveTenantPolicy } from './policy';
import type {
  DerivedRecordKind,
  MemoryAttribution,
  MemoryRecordSourceReference,
} from './record-governance';

export interface DeletionRequest {
  readonly attribution: MemoryAttribution;
  readonly resolved: ResolvedRecord;
  readonly trigger: MemoryDeletionReceipt['trigger'];
  readonly scope: MemoryDeletionReceipt['scope'];
}

/**
 * Executes COR-806's deletion plan. Before planning, the deletion claims the
 * record and everything its lineage reaches (each envelope's
 * `deletionRequestedAt`), reading the lineage again after each round of claims
 * until a read finds nothing new, so the plan also reaches whatever a promotion
 * or derived write running alongside published. A receipt is persisted before
 * anything is deleted; the synchronous lane then removes source evidence, canonical
 * projections, identity views, and the managed-asset canonical record in one
 * storage transaction; and each bounded-async target settles against its own
 * deadline. Every step is idempotent, so {@link DeletionEngine.processOpen}
 * resumes an interrupted deletion after a restart.
 *
 * A legal hold is checked again before the synchronous lane and before each
 * bounded-async target, and every record deletion is conditioned on the
 * versions that check read, so a hold placed at any point while the deletion
 * is in flight leaves the held record, and every target not yet settled, alone
 * until the hold is released.
 */
export interface DeletionEngine {
  requestDeletion(request: DeletionRequest): Promise<MemoryDeletionReceipt>;
  requeueAfterRelease(receipt: MemoryDeletionReceipt): Promise<MemoryDeletionReceipt | undefined>;
  /**
   * Resumes every open deletion, and re-queues any held deletion whose hold was
   * released without its re-queue being recorded.
   */
  processOpen(): Promise<MemoryDeletionReceipt[]>;
}

const SYNCHRONOUS: ReadonlySet<MemoryDeletionTarget> = new Set(SYNCHRONOUS_DELETION_TARGETS);

const TARGET_FOR_KIND: Readonly<Record<DerivedRecordKind, MemoryDeletionTarget>> = {
  'canonical-projection': 'canonical-projections',
  'identity-view': 'identity-views',
  'managed-asset-record': 'managed-asset-record',
  summary: 'summaries',
};

const PROJECTION_TARGETS: readonly MemoryDeletionTarget[] = ['indexes', 'caches', 'exports'];

/**
 * How many times the synchronous lane re-checks holds and retries its storage
 * transaction after a record it names changed underneath it. Past this, the
 * lane stays pending and the next propagation pass tries again.
 */
const SYNCHRONOUS_DELETION_ATTEMPTS = 3;

/** What a deletion saw of the records it names, just before it acts on them. */
interface Inspection {
  /** Whether any record that still exists is under legal hold. */
  readonly held: boolean;
  readonly contentDigests: readonly string[];
  /** The version of each record that still exists, keyed by {@link referenceKey}. */
  readonly versions: ReadonlyMap<string, number>;
}

/**
 * An embedder whose cache can evict entries by the SHA-256 digest of the content
 * they embedded, such as `withEmbeddingCache()`. Only such an embedder lets
 * the built-in `caches` handler claim eviction; any other cache needs a
 * configured propagator or a `not-retained` declaration.
 */
type ContentEvictingEmbedder = Embedder & {
  evictContent(contentDigests: readonly string[]): number | Promise<number>;
};

function evictsContent(embedder: Embedder): embedder is ContentEvictingEmbedder {
  return 'evictContent' in embedder && typeof embedder.evictContent === 'function';
}

function emptyPlan(): MemoryDeletionPlan {
  return { projections: [], identityViews: [], managedAssetRecords: [], summaries: [] };
}

function planFromLinks(links: readonly MemoryLineageLink[]): MemoryDeletionPlan {
  const pick = (kind: DerivedRecordKind) =>
    links
      .filter((link) => link.derived.kind === kind)
      .map((link) => ({ id: link.derived.id, namespace: link.derived.namespace }));
  return {
    projections: pick('canonical-projection'),
    identityViews: pick('identity-view'),
    managedAssetRecords: pick('managed-asset-record'),
    summaries: pick('summary'),
  };
}

function planForProjection(
  kind: DerivedRecordKind,
  reference: MemoryRecordSourceReference,
): MemoryDeletionPlan {
  const plan = emptyPlan();
  if (kind === 'canonical-projection') return { ...plan, projections: [reference] };
  if (kind === 'identity-view') return { ...plan, identityViews: [reference] };
  if (kind === 'managed-asset-record') return { ...plan, managedAssetRecords: [reference] };
  return { ...plan, summaries: [reference] };
}

export function planReferences(plan: MemoryDeletionPlan): MemoryRecordSourceReference[] {
  return [
    ...plan.projections,
    ...plan.identityViews,
    ...plan.managedAssetRecords,
    ...plan.summaries,
  ];
}

function referenceKey(reference: MemoryRecordSourceReference): string {
  return JSON.stringify([reference.namespace, reference.id]);
}

function sourceOf(receipt: MemoryDeletionReceipt): MemoryRecordSourceReference {
  return { id: receipt.record.id, namespace: receipt.record.namespace };
}

/** The deleted record and everything its plan reaches: the records a hold on any of which holds the deletion. */
function receiptReferences(receipt: MemoryDeletionReceipt): MemoryRecordSourceReference[] {
  return [sourceOf(receipt), ...planReferences(receipt.plan)];
}

/**
 * Storage references for a deletion, each conditioned on the version the
 * inspection read, so a record changed since then (a hold placed on it, say)
 * aborts the transaction instead of being deleted.
 */
function conditionedReferences(
  tenantId: string,
  references: readonly MemoryRecordSourceReference[],
  inspection: Inspection,
): MemoryRecordReference[] {
  return references.map((reference) => {
    const expectedVersion = inspection.versions.get(referenceKey(reference));
    return {
      id: reference.id,
      scope: { tenantId, namespace: reference.namespace },
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    };
  });
}

function presentCount(
  references: readonly MemoryRecordSourceReference[],
  inspection: Inspection,
): number {
  return references.filter((reference) => inspection.versions.has(referenceKey(reference))).length;
}

function targetRow(
  target: MemoryDeletionTarget,
  held: boolean,
  requestedAt: number,
  bound: number,
): MemoryDeletionTargetReceipt {
  const lane = SYNCHRONOUS.has(target) ? 'synchronous' : 'bounded-async';
  if (held) return { target, lane, status: 'exempt', detail: 'legal hold' };
  return {
    target,
    lane,
    status: 'pending',
    deadline: lane === 'synchronous' ? requestedAt : requestedAt + bound,
  };
}

function withOpen(receipt: MemoryDeletionReceipt, updatedAt: number): MemoryDeletionReceipt {
  return {
    ...receipt,
    open: receipt.targets.some((target) => target.status === 'pending'),
    updatedAt,
  };
}

/**
 * A hold found mid-deletion: every target not yet settled becomes exempt, and
 * the receipt closes waiting on the release, which re-queues what is left.
 * Targets that already settled keep their outcome.
 */
function holdRemaining(receipt: MemoryDeletionReceipt, now: number): MemoryDeletionReceipt {
  const targets = receipt.targets.map((target): MemoryDeletionTargetReceipt =>
    target.status === 'pending'
      ? {
          target: target.target,
          lane: target.lane,
          status: 'exempt',
          settledAt: now,
          detail: 'legal hold',
        }
      : target,
  );
  return withOpen({ ...receipt, targets, awaitingHoldRelease: true }, now);
}

export function createDeletionEngine(context: GovernanceContext): DeletionEngine {
  async function lineageClosure(
    tenantId: string,
    root: MemoryRecordSourceReference,
  ): Promise<MemoryLineageLink[]> {
    const links: MemoryLineageLink[] = [];
    const seen = new Set([JSON.stringify([root.namespace, root.id])]);
    const queue = [root];
    for (let reference = queue.shift(); reference !== undefined; reference = queue.shift()) {
      for (const link of await context.ledger.listLineage(tenantId, reference)) {
        const key = JSON.stringify([link.derived.namespace, link.derived.id]);
        if (seen.has(key)) continue;
        seen.add(key);
        links.push(link);
        queue.push(link.derived);
      }
    }
    return links;
  }

  /** Marks one record as claimed by a deletion; a record already gone needs no claim. */
  async function claim(resolved: ResolvedRecord): Promise<void> {
    await context.updateGovernance(resolved, (governance) =>
      governance.deletionRequestedAt === undefined
        ? { deletionRequestedAt: context.now() }
        : undefined,
    );
  }

  /**
   * Claims the deleted record, then everything its lineage reaches, and plans
   * from the lineage as it stands once a read after the latest claims finds
   * nothing new. A promotion or derived write re-checks its sources after
   * storing and linking its record: one that re-checks after a claim withdraws
   * its record, and one that re-checked before it had already written its
   * link, which the next read finds. A projection deletion removes one
   * derived record, so it claims only that one.
   */
  async function claimPlan(
    request: DeletionRequest,
    reference: MemoryRecordSourceReference,
  ): Promise<MemoryDeletionPlan> {
    const { resolved } = request;
    await claim(resolved);
    if (request.scope === 'projection') {
      return planForProjection(resolved.read.governance.lineage!.kind, reference);
    }
    const tenantId = resolved.scope.tenantId;
    const claimed = new Set<string>();
    for (;;) {
      const links = await lineageClosure(tenantId, reference);
      const unclaimed = links.filter((link) => !claimed.has(referenceKey(link.derived)));
      if (unclaimed.length === 0) return planFromLinks(links);
      for (const link of unclaimed) {
        claimed.add(referenceKey(link.derived));
        const derived = await context.load(tenantId, link.derived);
        if (derived !== undefined) await claim(derived);
      }
    }
  }

  /** Reloads `references`: which still exist, at which version, and whether any is held. */
  async function inspectReferences(
    tenantId: string,
    references: readonly MemoryRecordSourceReference[],
  ): Promise<Inspection> {
    let held = false;
    const contentDigests: string[] = [];
    const versions = new Map<string, number>();
    for (const reference of references) {
      const resolved = await context.load(tenantId, reference);
      if (resolved === undefined) continue;
      held ||= resolved.read.governance.legalHold === 'held';
      contentDigests.push(resolved.read.governance.contentDigest);
      versions.set(referenceKey(reference), resolved.record.version);
    }
    return { held, contentDigests, versions };
  }

  async function persist(
    receipt: MemoryDeletionReceipt,
    type: string,
  ): Promise<MemoryDeletionReceipt> {
    await context.ledger.putReceipt(receipt);
    await context.recordEvent({
      tenantId: receipt.tenantId,
      type,
      outcome: receipt.open ? 'pending' : 'settled',
      attribution: receipt.requestedBy,
      recordIds: [receipt.record.id],
      details: {
        deletionId: receipt.deletionId,
        trigger: receipt.trigger,
        ...Object.fromEntries(receipt.targets.map((target) => [target.target, target.status])),
      },
    });
    return receipt;
  }

  /** The synchronous lane's storage transaction, conditioned on what `inspection` read. */
  async function deleteSynchronous(
    receipt: MemoryDeletionReceipt,
    inspection: Inspection,
  ): Promise<'deleted' | 'failed' | 'conflict'> {
    const references = [
      ...(receipt.scope === 'source' ? [sourceOf(receipt)] : []),
      ...receipt.plan.projections,
      ...receipt.plan.identityViews,
      ...receipt.plan.managedAssetRecords,
    ];
    try {
      await context.deleteMany(conditionedReferences(receipt.tenantId, references, inspection));
      return 'deleted';
    } catch (error) {
      return error instanceof MemoryRecordVersionConflictError ? 'conflict' : 'failed';
    }
  }

  async function settleSynchronous(
    receipt: MemoryDeletionReceipt,
    succeeded: boolean,
    inspection: Inspection,
  ): Promise<MemoryDeletionReceipt> {
    const now = context.now();
    const { plan } = receipt;
    const details: Record<SynchronousDeletionTarget, string> = {
      'source-evidence': 'source evidence removed',
      'canonical-projections': `${presentCount(plan.projections, inspection)} canonical projection(s) removed`,
      'identity-views': `${presentCount(plan.identityViews, inspection)} identity view(s) removed`,
      'managed-asset-record': `${presentCount(plan.managedAssetRecords, inspection)} managed-asset canonical record(s) removed`,
    };
    const targets = receipt.targets.map((target): MemoryDeletionTargetReceipt => {
      if (target.lane !== 'synchronous' || target.status !== 'pending') return target;
      return succeeded
        ? {
            ...target,
            status: 'completed',
            settledAt: now,
            detail: details[target.target as SynchronousDeletionTarget],
          }
        : { ...target, status: 'failed', settledAt: now, detail: 'storage transaction failed' };
    });
    // A source deletion removes everything its lineage reaches, so those links
    // are spent. A projection deletion removes one derived record while records
    // derived from it survive: its links stay, so deleting its source later
    // still reaches them through it.
    if (succeeded && receipt.scope === 'source') {
      for (const reference of receiptReferences(receipt)) {
        await context.ledger.deleteLineage(receipt.tenantId, reference);
      }
    }
    return withOpen({ ...receipt, targets }, now);
  }

  async function executeSynchronous(
    receipt: MemoryDeletionReceipt,
  ): Promise<MemoryDeletionReceipt> {
    const pending = receipt.targets.some(
      (target) => target.lane === 'synchronous' && target.status === 'pending',
    );
    if (!pending) return receipt;
    for (let attempt = 0; attempt < SYNCHRONOUS_DELETION_ATTEMPTS; attempt++) {
      // A hold placed after the deletion was requested (before a restart, say)
      // is honored here; one placed after this check changes the held record's
      // version, which aborts the conditioned transaction and brings us back.
      const inspection = await inspectReferences(receipt.tenantId, receiptReferences(receipt));
      if (inspection.held) return holdRemaining(receipt, context.now());
      const outcome = await deleteSynchronous(receipt, inspection);
      if (outcome !== 'conflict') {
        return settleSynchronous(receipt, outcome === 'deleted', inspection);
      }
    }
    const targets = receipt.targets.map((target): MemoryDeletionTargetReceipt =>
      target.lane === 'synchronous' && target.status === 'pending'
        ? { ...target, detail: 'records changed during deletion; will retry' }
        : target,
    );
    return withOpen({ ...receipt, targets }, context.now());
  }

  async function builtIn(
    target: AsynchronousDeletionTarget,
    receipt: MemoryDeletionReceipt,
    inspection: Inspection,
  ): Promise<MemoryDeletionPropagationResult> {
    const references = receiptReferences(receipt);
    if (target === 'indexes') {
      for (const reference of references) await context.textSearchProvider?.remove(reference.id);
      return {
        status: 'completed',
        detail: 'text index entries and record-resident vectors removed',
      };
    }
    if (target === 'caches' && evictsContent(context.embedder)) {
      const evicted = await context.embedder.evictContent(receipt.contentDigests);
      return { status: 'completed', detail: `${evicted} cached embedding(s) evicted` };
    }
    if (target === 'summaries') {
      // Conditioned on the hold check just made: a summary held since then
      // aborts this attempt, and the next pass finds the hold.
      const { summaries } = receipt.plan;
      await context.deleteMany(conditionedReferences(receipt.tenantId, summaries, inspection));
      return {
        status: 'completed',
        detail: `${presentCount(summaries, inspection)} summary record(s) removed`,
      };
    }
    if (target === 'exports')
      return scrubExports(
        receipt,
        references.map((reference) => reference.id),
      );
    return { status: 'pending', detail: 'no propagator configured for this target' };
  }

  /**
   * Scrubs the deleted records from every export listing them. Each scrub
   * merges onto the manifest as stored when it lands, so an export revoked
   * meanwhile stays revoked.
   */
  async function scrubExports(
    receipt: MemoryDeletionReceipt,
    recordIds: readonly string[],
  ): Promise<MemoryDeletionPropagationResult> {
    const touched = new Set<string>();
    for (const recordId of recordIds) {
      for (const manifest of await context.ledger.listExports({
        tenantId: receipt.tenantId,
        recordId,
      })) {
        touched.add(manifest.exportId);
      }
    }
    for (const exportId of touched) {
      await context.ledger.scrubExport(receipt.tenantId, exportId, recordIds);
    }
    return { status: 'completed', detail: `${touched.size} export manifest(s) scrubbed` };
  }

  async function propagate(
    target: AsynchronousDeletionTarget,
    receipt: MemoryDeletionReceipt,
    inspection: Inspection,
  ): Promise<MemoryDeletionPropagationResult> {
    const configured: MemoryDeletionPropagator | 'not-retained' | undefined =
      context.propagation[target];
    try {
      if (configured === 'not-retained') {
        return { status: 'completed', detail: 'not retained by this deployment' };
      }
      if (configured !== undefined) {
        return await configured.propagate({
          deletionId: receipt.deletionId,
          tenantId: receipt.tenantId,
          target,
          record: receipt.record,
          plan: receipt.plan,
          contentDigests: receipt.contentDigests,
        });
      }
      return await builtIn(target, receipt, inspection);
    } catch {
      return { status: 'pending', detail: 'propagation attempt failed' };
    }
  }

  async function settleAsynchronous(
    target: MemoryDeletionTargetReceipt,
    receipt: MemoryDeletionReceipt,
    inspection: Inspection,
  ): Promise<MemoryDeletionTargetReceipt> {
    const result = await propagate(
      target.target as AsynchronousDeletionTarget,
      receipt,
      inspection,
    );
    const now = context.now();
    const detail = result.detail ? { detail: result.detail } : {};
    if (result.status !== 'pending') {
      return { ...target, status: result.status, settledAt: now, ...detail };
    }
    if (target.deadline !== undefined && now >= target.deadline) {
      return {
        ...target,
        status: 'failed',
        settledAt: now,
        detail: 'deadline passed before propagation completed',
      };
    }
    return { ...target, ...detail };
  }

  async function advanceAsynchronous(
    receipt: MemoryDeletionReceipt,
  ): Promise<MemoryDeletionReceipt> {
    let current = receipt;
    for (const [index, target] of receipt.targets.entries()) {
      if (target.lane !== 'bounded-async' || target.status !== 'pending') continue;
      // Each target first re-checks every record the deletion names: a hold
      // placed since the last step leaves this target and the rest alone.
      const inspection = await inspectReferences(receipt.tenantId, receiptReferences(receipt));
      if (inspection.held) return holdRemaining(current, context.now());
      const settled = await settleAsynchronous(target, current, inspection);
      current = { ...current, targets: current.targets.with(index, settled) };
    }
    return withOpen(current, context.now());
  }

  async function run(receipt: MemoryDeletionReceipt): Promise<MemoryDeletionReceipt> {
    const synchronous = await executeSynchronous(receipt);
    const settled = synchronous.awaitingHoldRelease
      ? synchronous
      : await advanceAsynchronous(synchronous);
    return persist(settled, 'memory.deletion.propagated');
  }

  async function requestDeletion(request: DeletionRequest): Promise<MemoryDeletionReceipt> {
    const { resolved } = request;
    const { governance } = resolved.read;
    const tenantId = resolved.scope.tenantId;
    const reference = { id: resolved.record.id, namespace: resolved.scope.namespace };
    const requestedAt = context.now();
    const bound = resolveTenantPolicy(context.policy(), tenantId).deletionBoundMilliseconds;
    const plan = await claimPlan(request, reference);
    const rows =
      request.scope === 'source'
        ? [...SYNCHRONOUS_DELETION_TARGETS, ...ASYNCHRONOUS_DELETION_TARGETS]
        : [TARGET_FOR_KIND[governance.lineage!.kind], ...PROJECTION_TARGETS];
    // A hold on the record or on anything derived from it holds the whole
    // deletion: the synchronous lane is one transaction and cannot remove the
    // source while leaving a held projection pointing at nothing.
    const derived = await inspectReferences(tenantId, planReferences(plan));
    const held = governance.legalHold === 'held' || derived.held;
    const receipt: MemoryDeletionReceipt = withOpen(
      {
        version: 1,
        deletionId: context.runtime.identifiers.next('memory-deletion'),
        tenantId,
        scope: request.scope,
        trigger: request.trigger,
        record: {
          id: resolved.record.id,
          namespace: resolved.scope.namespace,
          ownerId: governance.ownerId,
          collection: governance.collection,
          memoryClass: governance.memoryClass,
          contentDigest: governance.contentDigest,
        },
        plan,
        contentDigests: [...new Set([governance.contentDigest, ...derived.contentDigests])],
        requestedBy: request.attribution,
        requestedAt,
        boundMilliseconds: bound,
        awaitingHoldRelease: held,
        targets: rows.map((target) => targetRow(target, held, requestedAt, bound)),
        open: false,
        updatedAt: requestedAt,
      },
      requestedAt,
    );
    await persist(receipt, 'memory.deletion.requested');
    return held ? receipt : run(receipt);
  }

  /**
   * Continues a deletion that a hold stopped after its source was already
   * removed: a new receipt, over the same plan, runs every target the hold
   * exempted and carries over what had already settled.
   */
  async function resumeDeletion(held: MemoryDeletionReceipt): Promise<MemoryDeletionReceipt> {
    const requestedAt = context.now();
    const bound = resolveTenantPolicy(context.policy(), held.tenantId).deletionBoundMilliseconds;
    const receipt = withOpen(
      {
        ...held,
        deletionId: context.runtime.identifiers.next('memory-deletion'),
        trigger: 'hold-release',
        requestedAt,
        boundMilliseconds: bound,
        awaitingHoldRelease: false,
        targets: held.targets.map((target) =>
          target.status === 'exempt' ? targetRow(target.target, false, requestedAt, bound) : target,
        ),
      },
      requestedAt,
    );
    await persist(receipt, 'memory.deletion.requested');
    return run(receipt);
  }

  /**
   * Re-queues a held deletion once its hold is released: a fresh deletion when
   * its record still exists, or the rest of the same plan when the hold stopped
   * it partway. The new receipt is recorded before the held one closes, so a
   * crash in between leaves the held receipt waiting, and
   * {@link DeletionEngine.processOpen} re-queues it again (finding the record
   * already gone if the new deletion ran).
   */
  async function requeueAfterRelease(
    receipt: MemoryDeletionReceipt,
  ): Promise<MemoryDeletionReceipt | undefined> {
    const resolved = await context.load(receipt.tenantId, sourceOf(receipt));
    const partial = receipt.targets.some((target) => target.status !== 'exempt');
    let next: MemoryDeletionReceipt | undefined;
    if (resolved !== undefined) {
      next = await requestDeletion({
        attribution: receipt.requestedBy,
        resolved,
        trigger: 'hold-release',
        scope: receipt.scope,
      });
    } else if (partial) {
      next = await resumeDeletion(receipt);
    }
    await context.ledger.putReceipt({
      ...receipt,
      awaitingHoldRelease: false,
      updatedAt: context.now(),
    });
    return next;
  }

  async function holdStillApplies(receipt: MemoryDeletionReceipt): Promise<boolean> {
    const inspection = await inspectReferences(receipt.tenantId, receiptReferences(receipt));
    return inspection.held;
  }

  return {
    requestDeletion,
    requeueAfterRelease,

    async processOpen() {
      const settled: MemoryDeletionReceipt[] = [];
      for (const receipt of await context.ledger.listReceipts({ open: true })) {
        settled.push(await run(receipt));
      }
      // A release that died after lifting its hold but before re-queueing left
      // its held receipt waiting on a hold that no longer applies: resume it.
      for (const receipt of await context.ledger.listReceipts({ open: false })) {
        if (!receipt.awaitingHoldRelease || (await holdStillApplies(receipt))) continue;
        const next = await requeueAfterRelease(receipt);
        if (next !== undefined) settled.push(next);
      }
      return settled;
    },
  };
}
