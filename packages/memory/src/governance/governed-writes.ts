import type { GuardrailProvenance } from 'armorer';

import type { MemoryRecord } from '../memory-record-storage';
import {
  type MemoryAuthority,
  delegationChainIncludes,
  holdsGovernanceAuthority,
  holdsServiceAuthority,
} from './authority';
import { type GovernedContentScan, scanGovernedContent } from './content-scan';
import { type DerivationBlocker, derivationBlocker, settleStoredDerivation } from './derivation';
import {
  type GovernanceContext,
  type ResolvedRecord,
  type TenantScope,
  authorizeLocated,
  ownPrivateResource,
} from './governance-context';
import type {
  GovernedWriteOptions,
  MemoryRecordLocator,
  MemoryWriteReceipt,
  MemoryWriteRejection,
} from './governed-memory-types';
import type { MemoryProtectedDiagnostic } from './ledger-types';
import { type MemorySourceKind, type MemoryTrust, lowestTrust } from './policy';
import {
  MEMORY_GOVERNANCE_METADATA_KEY,
  type MemoryRecordLineage,
  type RecordGovernance,
  digestContent,
  withoutReservedMetadata,
} from './record-governance';

const MODEL_REACHABLE_KINDS = ['agent', 'run', 'tool'] as const;

/**
 * Classifies whether a principal may claim a source. Anything an agent, run, or
 * tool touched can only enter as an untrusted source. `system` content needs a
 * chain of service and governance principals only; `operator` content needs a
 * human actor, or a chain of governance principals, with no model-reachable link
 * anywhere in its delegation chain.
 */
export function sourcePermitted(authority: MemoryAuthority, source: MemorySourceKind): boolean {
  if (source === 'system') return holdsServiceAuthority(authority);
  if (source !== 'operator') return true;
  if (delegationChainIncludes(authority, MODEL_REACHABLE_KINDS)) return false;
  return authority.principal.kind === 'user' || holdsGovernanceAuthority(authority);
}

function provenanceFor(source: MemorySourceKind): GuardrailProvenance {
  return source === 'ingested-document' ? 'ingested-document' : 'user-input';
}

function contentValid(content: string, maxLength: number): boolean {
  return (
    typeof content === 'string' &&
    content.trim().length > 0 &&
    content.length <= maxLength &&
    !content.includes('\u0000')
  );
}

export interface AdmittedRecordInput {
  readonly authority: MemoryAuthority;
  readonly operationId: string;
  readonly content: string;
  readonly options: GovernedWriteOptions;
  readonly scope: TenantScope;
  readonly trust: MemoryTrust;
  readonly state: RecordGovernance['state'];
  readonly lineage?: MemoryRecordLineage;
  readonly visibility?: RecordGovernance['visibility'];
  readonly vector?: Float32Array;
}

/**
 * What storing a governed record came to. A derived record whose sources no
 * longer back it once it is stored is `withdrawn`: it never became visible,
 * and the operation that stored it did not happen.
 */
export type StoredGovernedRecord =
  | { readonly outcome: 'stored' | 'duplicate'; readonly record: MemoryRecord }
  | {
      readonly outcome: 'withdrawn';
      readonly record: MemoryRecord;
      readonly reason: DerivationBlocker;
    };

/** Embeds one text through the governed memory's embedder. */
export async function embedOne(context: GovernanceContext, text: string): Promise<Float32Array> {
  const [vector] = await context.embedder([text]);
  return new Float32Array(vector!);
}

/**
 * Builds and stores a governed record with its persisted envelope and
 * attribution. A derived record fails closed: it is stored pending, which
 * every governed read and transition treats as missing, checked against its
 * sources again once it is stored and linked, and only then activated. It is
 * withdrawn instead when any source is gone, has left `active`, or has been
 * claimed by a deletion. A durable pending entry in the ledger precedes the
 * record, so a withdrawal that fails, or a process that dies, leaves a hidden
 * record that `processDeletionPropagation` resolves.
 */
export async function storeGovernedRecord(
  context: GovernanceContext,
  input: AdmittedRecordInput,
): Promise<StoredGovernedRecord> {
  const now = context.now();
  const { authority, options } = input;
  const governance: RecordGovernance = {
    version: 1,
    tenantId: authority.tenantId,
    ownerId: authority.ownerId,
    collection: options.collection,
    visibility: input.visibility ?? 'private',
    memoryClass: options.memoryClass ?? 'episodic',
    source: options.source,
    trust: input.trust,
    state: input.state,
    legalHold: 'none',
    sharedWith: [],
    contentDigest: digestContent(input.content),
    eventAt: options.eventAt ?? now,
    retrievalWeight: 1,
    indexInvalidated: false,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(input.lineage === undefined
      ? {}
      : { lineage: input.lineage, pendingDerivation: true as const }),
    attribution: context.attribution(authority, input.operationId),
  };
  const vector = input.vector ?? (await embedOne(context, input.content));
  // Only the write option sets the operation key; a `dedupeKey` smuggled in
  // through extension metadata would otherwise claim another write's key.
  const { dedupeKey: _callerKey, ...extension } = withoutReservedMetadata(options.metadata ?? {});
  const record: MemoryRecord = {
    id: context.runtime.identifiers.next('memory'),
    tenantId: input.scope.tenantId,
    namespace: input.scope.namespace,
    content: input.content,
    vector,
    metadata: {
      ...extension,
      ...(options.dedupeKey === undefined ? {} : { dedupeKey: options.dedupeKey }),
      [MEMORY_GOVERNANCE_METADATA_KEY]: governance,
    },
    createdAt: now,
    updatedAt: now,
    version: 1,
    status: 'active',
  };
  // The ledger learns about the record before the record exists. A scope, a
  // pending entry, or a lineage link naming a record that was never stored is
  // harmless, because every reader skips absent references; a stored record
  // the ledger does not know is one retention, revocation, deletion, or the
  // propagation pass can never reach.
  const { tenantId } = input.scope;
  const reference = { id: record.id, namespace: input.scope.namespace };
  await context.ledger.registerScope(input.scope);
  const { lineage } = input;
  if (lineage !== undefined) {
    await context.ledger.putPendingDerivation({ tenantId, record: reference, startedAt: now });
    for (const source of lineage.sources) {
      await context.ledger.putLineage({
        tenantId,
        source,
        derived: { ...reference, kind: lineage.kind },
      });
    }
  }
  if (options.dedupeKey !== undefined && context.storage.putOnce !== undefined) {
    const stored = await context.storage.putOnce(record);
    if (!stored.inserted) {
      // This record was never stored, so its pending entry has nothing to settle.
      if (lineage !== undefined) await context.ledger.deletePendingDerivation(tenantId, reference);
      return { outcome: 'duplicate', record: stored.record };
    }
  } else {
    await context.storage.put(record);
  }
  if (lineage === undefined) {
    if (input.state === 'active') {
      await context.textSearchProvider?.index(record.id, input.content, input.scope.namespace);
    }
    return { outcome: 'stored', record };
  }
  const settlement = await settleStoredDerivation(context, tenantId, reference);
  return settlement.outcome === 'active'
    ? { outcome: 'stored', record }
    : { outcome: 'withdrawn', record, reason: settlement.reason };
}

interface AdmissionFailure {
  readonly reason: MemoryWriteRejection;
}

function requestFailure(
  authority: MemoryAuthority,
  content: string,
  options: GovernedWriteOptions,
  maxLength: number,
): AdmissionFailure | undefined {
  if (!contentValid(content, maxLength)) return { reason: 'invalid-content' };
  if (options.collection.length === 0) return { reason: 'invalid-request' };
  if ((options.memoryClass ?? 'episodic') === 'working' && options.runId === undefined) {
    return { reason: 'invalid-request' };
  }
  if (!sourcePermitted(authority, options.source)) return { reason: 'source-not-permitted' };
  return undefined;
}

async function reject(
  context: GovernanceContext,
  authority: MemoryAuthority,
  operationId: string,
  reason: MemoryWriteRejection,
  diagnostic?: MemoryProtectedDiagnostic,
): Promise<MemoryWriteReceipt> {
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: 'memory.write.rejected',
    outcome: 'rejected',
    attribution: context.attribution(authority, operationId),
    recordIds: [],
    reason,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  });
  return { operationId, status: 'rejected', reason };
}

/**
 * Resolves the sources a derived write names. Each must be a record the caller
 * may write, still active, not superseded, and not claimed by a deletion; any
 * other case fails the write without saying which source was missing or
 * unauthorized.
 */
async function resolveDerivedSources(
  context: GovernanceContext,
  authority: MemoryAuthority,
  sources: readonly MemoryRecordLocator[],
  operationId: string,
): Promise<ResolvedRecord[] | undefined> {
  const resolved: ResolvedRecord[] = [];
  for (const locator of sources) {
    const located = await authorizeLocated(context, authority, 'write', locator, operationId);
    if (!('resolved' in located)) return undefined;
    const { governance } = located.resolved.read;
    if (governance.invalidatedAt !== undefined || derivationBlocker(governance) !== undefined) {
      return undefined;
    }
    resolved.push(located.resolved);
  }
  return resolved;
}

function admissionDiagnostic(
  scan: Extract<GovernedContentScan, { flagged: true }>,
  contentDigest: string,
): MemoryProtectedDiagnostic {
  return {
    detector: scan.detector,
    category: scan.category,
    confidence: scan.confidence,
    contentDigest,
  };
}

/**
 * Admission for every governed write. Ordinary conversation and model-facing
 * tools are untrusted writers: the source and its trust are classified from the
 * persisted authority, content is validated and scanned, quotas apply, and a
 * detection quarantines (or rejects) the write. A derived write is never more
 * trusted than its least trusted source. The writer learns only the outcome;
 * which detector fired, and why, is recorded as a protected diagnostic.
 */
export async function admitWrite(
  context: GovernanceContext,
  authority: MemoryAuthority,
  content: string,
  options: GovernedWriteOptions,
): Promise<MemoryWriteReceipt> {
  const operationId = context.operationId();
  const policy = context.policy();
  const allowed = await context.authorize(authority, 'write', ownPrivateResource(authority), {
    operationId,
    recordIds: [],
  });
  if (!allowed.allowed) return { operationId, status: 'rejected', reason: 'missing-capability' };
  const failure = requestFailure(authority, content, options, policy.admission.maxContentLength);
  if (failure !== undefined) return reject(context, authority, operationId, failure.reason);
  const scope = context.scope(authority.tenantId, 'private', authority.ownerId, options.collection);
  if (options.dedupeKey !== undefined) {
    const existing = await context.storage.getByDedupeKey?.(scope, options.dedupeKey);
    if (existing !== undefined) return { operationId, status: 'duplicate', recordId: existing.id };
  }
  const sources =
    options.derivedFrom === undefined
      ? []
      : await resolveDerivedSources(context, authority, options.derivedFrom.sources, operationId);
  if (sources === undefined || (options.derivedFrom !== undefined && sources.length === 0)) {
    return reject(context, authority, operationId, 'invalid-source');
  }
  if ((await context.storage.count(scope)) >= policy.admission.maxRecordsPerCollection) {
    return reject(context, authority, operationId, 'quota-exceeded');
  }
  const scan = await scanGovernedContent(
    content,
    policy.admission.detectors,
    provenanceFor(options.source),
  );
  const contentDigest = digestContent(content);
  if (scan.flagged && policy.admission.onDetection === 'reject') {
    return reject(
      context,
      authority,
      operationId,
      'content-policy',
      admissionDiagnostic(scan, contentDigest),
    );
  }
  const state = scan.flagged ? 'quarantined' : 'active';
  const sourceReferences = sources.map((source) => ({
    id: source.record.id,
    namespace: source.scope.namespace,
  }));
  const stored = await storeGovernedRecord(context, {
    authority,
    operationId,
    content,
    options,
    scope,
    trust: lowestTrust([
      policy.admission.sourceTrust[options.source],
      ...sources.map((source) => source.read.governance.trust),
    ]),
    state,
    ...(options.derivedFrom === undefined
      ? {}
      : { lineage: { kind: options.derivedFrom.kind, sources: sourceReferences } }),
  });
  if (stored.outcome === 'duplicate') {
    return { operationId, status: 'duplicate', recordId: stored.record.id };
  }
  if (stored.outcome === 'withdrawn') {
    return reject(context, authority, operationId, 'invalid-source');
  }
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: scan.flagged ? 'memory.write.quarantined' : 'memory.write.admitted',
    outcome: state === 'active' ? 'admitted' : 'quarantined',
    attribution: context.attribution(authority, operationId),
    recordIds: [stored.record.id, ...sourceReferences.map((source) => source.id)],
    details: { source: options.source, memoryClass: options.memoryClass ?? 'episodic' },
    ...(scan.flagged
      ? { reason: 'content-policy', diagnostic: admissionDiagnostic(scan, contentDigest) }
      : {}),
  });
  return {
    operationId,
    status: state === 'active' ? 'admitted' : 'quarantined',
    recordId: stored.record.id,
  };
}

/**
 * Stamps supersession onto a record: it stays for history but leaves active
 * use. The stamp merges onto the record as it is now, so a revocation or legal
 * hold that landed while the successor was admitted survives it.
 */
export async function stampInvalidated(
  context: GovernanceContext,
  resolved: ResolvedRecord,
  successorId: string,
): Promise<void> {
  await context.updateGovernance(resolved, {
    invalidatedAt: context.now(),
    supersededBy: successorId,
  });
}
