import type { InputDetector } from 'armorer';

import { createMemoryPoisoningDetector } from './poisoning-detector';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** COR-806: the bounded-async deletion lane's default bound, configurable per tenant. */
export const DEFAULT_DELETION_BOUND_MILLISECONDS = 24 * HOUR;
/** COR-806: episodic memory retains 90 days from its event or observation time. */
export const DEFAULT_EPISODIC_RETENTION_MILLISECONDS = 90 * DAY;
/** COR-806: a superseded semantic or procedural record retains 90 days from `invalidatedAt`. */
export const DEFAULT_SUPERSEDED_RETENTION_MILLISECONDS = 90 * DAY;
/** COR-806: audit receipts retain one year at minimum. */
export const MINIMUM_AUDIT_RECEIPT_RETENTION_MILLISECONDS = 365 * DAY;

/** The six memory kinds of the canonical lifecycle contract (COR-750). */
export const MEMORY_CLASSES = [
  'working',
  'episodic',
  'semantic',
  'procedural',
  'identity',
  'resource',
] as const;
export type MemoryClass = (typeof MEMORY_CLASSES)[number];

/**
 * Where content came from. Ordinary conversation, model-facing tools, tool
 * results, ingested documents, and derived views are untrusted memory-write
 * interfaces; only operator and system writes can start out trusted.
 */
export const MEMORY_SOURCE_KINDS = [
  'conversation',
  'model-tool',
  'tool-result',
  'ingested-document',
  'derived',
  'operator',
  'system',
] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

/** Ordered lowest to highest. */
export const MEMORY_TRUST_LEVELS = ['untrusted', 'verified', 'system'] as const;
export type MemoryTrust = (typeof MEMORY_TRUST_LEVELS)[number];

export type MemoryRetentionRule =
  | { readonly kind: 'run-lifetime' }
  | { readonly kind: 'duration'; readonly milliseconds: number }
  | { readonly kind: 'until-superseded'; readonly supersededMilliseconds: number }
  | { readonly kind: 'subject-deletable' }
  | { readonly kind: 'source-linked' };

export interface MemoryAdmissionPolicy {
  /** Detectors every write runs through. A detector that throws counts as a detection. */
  readonly detectors: readonly InputDetector[];
  /** What a detection does to the write. */
  readonly onDetection: 'quarantine' | 'reject';
  readonly maxContentLength: number;
  readonly maxRecordsPerCollection: number;
  readonly sourceTrust: Readonly<Record<MemorySourceKind, MemoryTrust>>;
}

export interface MemoryRecallPolicy {
  /** Detectors every recalled record runs through before it can reach a model. */
  readonly detectors: readonly InputDetector[];
  /** The lowest trust a record of each class needs before it can reach a model. */
  readonly minimumTrust: Readonly<Record<MemoryClass, MemoryTrust>>;
}

export interface MemoryRetentionPolicy {
  readonly classes: Readonly<Record<MemoryClass, MemoryRetentionRule>>;
  readonly auditReceiptMilliseconds: number;
}

export interface MemoryTenantPolicyOverride {
  readonly deletionBoundMilliseconds?: number;
  readonly retention?: Partial<Record<MemoryClass, MemoryRetentionRule>>;
  readonly auditReceiptMilliseconds?: number;
}

/**
 * A versioned governance policy. Its `revision` is recorded on every write,
 * receipt, and event, so a rollout or rollback is always attributable; rolling
 * back changes future decisions only and never resurrects anything already
 * revoked or deleted.
 */
export interface MemoryGovernancePolicy {
  readonly revision: string;
  readonly admission: MemoryAdmissionPolicy;
  readonly recall: MemoryRecallPolicy;
  readonly retention: MemoryRetentionPolicy;
  readonly deletionBoundMilliseconds: number;
  readonly tenants: Readonly<Record<string, MemoryTenantPolicyOverride>>;
}

export interface CreateMemoryGovernancePolicyInput {
  readonly revision: string;
  readonly admission?: Partial<Omit<MemoryAdmissionPolicy, 'sourceTrust'>> & {
    readonly sourceTrust?: Partial<Record<MemorySourceKind, MemoryTrust>>;
  };
  readonly recall?: {
    readonly detectors?: readonly InputDetector[];
    readonly minimumTrust?: Partial<Record<MemoryClass, MemoryTrust>>;
  };
  readonly retention?: Partial<Record<MemoryClass, MemoryRetentionRule>>;
  readonly auditReceiptMilliseconds?: number;
  readonly deletionBoundMilliseconds?: number;
  readonly tenants?: Readonly<Record<string, MemoryTenantPolicyOverride>>;
}

export class MemoryGovernancePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryGovernancePolicyError';
  }
}

const DEFAULT_RETENTION: Readonly<Record<MemoryClass, MemoryRetentionRule>> = Object.freeze({
  working: { kind: 'run-lifetime' },
  episodic: { kind: 'duration', milliseconds: DEFAULT_EPISODIC_RETENTION_MILLISECONDS },
  semantic: {
    kind: 'until-superseded',
    supersededMilliseconds: DEFAULT_SUPERSEDED_RETENTION_MILLISECONDS,
  },
  procedural: {
    kind: 'until-superseded',
    supersededMilliseconds: DEFAULT_SUPERSEDED_RETENTION_MILLISECONDS,
  },
  identity: { kind: 'subject-deletable' },
  resource: { kind: 'source-linked' },
});

const DEFAULT_SOURCE_TRUST: Readonly<Record<MemorySourceKind, MemoryTrust>> = Object.freeze({
  conversation: 'untrusted',
  'model-tool': 'untrusted',
  'tool-result': 'untrusted',
  'ingested-document': 'untrusted',
  derived: 'untrusted',
  operator: 'verified',
  system: 'system',
});

const DEFAULT_MINIMUM_TRUST: Readonly<Record<MemoryClass, MemoryTrust>> = Object.freeze({
  working: 'untrusted',
  episodic: 'untrusted',
  semantic: 'untrusted',
  procedural: 'verified',
  identity: 'verified',
  resource: 'untrusted',
});

function requirePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new MemoryGovernancePolicyError(`${label} must be a positive number.`);
  }
}

function requireAuditRetention(value: number, label: string): void {
  if (!Number.isFinite(value) || value < MINIMUM_AUDIT_RECEIPT_RETENTION_MILLISECONDS) {
    throw new MemoryGovernancePolicyError(`${label} must retain audit receipts for one year.`);
  }
}

function validateRetentionRules(
  rules: Partial<Record<MemoryClass, MemoryRetentionRule>>,
  label: string,
): void {
  for (const [memoryClass, rule] of Object.entries(rules)) {
    if (rule.kind === 'duration') requirePositive(rule.milliseconds, `${label}.${memoryClass}`);
    if (rule.kind === 'until-superseded') {
      requirePositive(rule.supersededMilliseconds, `${label}.${memoryClass}`);
    }
  }
}

function validateTenants(tenants: Readonly<Record<string, MemoryTenantPolicyOverride>>): void {
  for (const [tenantId, override] of Object.entries(tenants)) {
    if (override.deletionBoundMilliseconds !== undefined) {
      requirePositive(override.deletionBoundMilliseconds, `tenants.${tenantId}.deletionBound`);
    }
    if (override.auditReceiptMilliseconds !== undefined) {
      requireAuditRetention(override.auditReceiptMilliseconds, `tenants.${tenantId}`);
    }
    validateRetentionRules(override.retention ?? {}, `tenants.${tenantId}.retention`);
  }
}

/**
 * Builds a governance policy from COR-806's binding defaults plus overrides.
 * Validation fails closed: admission and recall must each run at least one
 * detector (recall admission is mandatory), bounds and quotas must be positive,
 * and audit receipts must retain for at least one year.
 */
export function createMemoryGovernancePolicy(
  input: CreateMemoryGovernancePolicyInput,
): MemoryGovernancePolicy {
  if (input.revision.length === 0) {
    throw new MemoryGovernancePolicyError('A governance policy needs a revision.');
  }
  const admission: MemoryAdmissionPolicy = {
    detectors: input.admission?.detectors ?? [createMemoryPoisoningDetector()],
    onDetection: input.admission?.onDetection ?? 'quarantine',
    maxContentLength: input.admission?.maxContentLength ?? 32_768,
    maxRecordsPerCollection: input.admission?.maxRecordsPerCollection ?? 10_000,
    sourceTrust: { ...DEFAULT_SOURCE_TRUST, ...input.admission?.sourceTrust },
  };
  const recall: MemoryRecallPolicy = {
    detectors: input.recall?.detectors ?? [createMemoryPoisoningDetector()],
    minimumTrust: { ...DEFAULT_MINIMUM_TRUST, ...input.recall?.minimumTrust },
  };
  if (admission.detectors.length === 0 || recall.detectors.length === 0) {
    throw new MemoryGovernancePolicyError('Admission and recall each need at least one detector.');
  }
  requirePositive(admission.maxContentLength, 'admission.maxContentLength');
  requirePositive(admission.maxRecordsPerCollection, 'admission.maxRecordsPerCollection');
  const retention: MemoryRetentionPolicy = {
    classes: { ...DEFAULT_RETENTION, ...input.retention },
    auditReceiptMilliseconds:
      input.auditReceiptMilliseconds ?? MINIMUM_AUDIT_RECEIPT_RETENTION_MILLISECONDS,
  };
  validateRetentionRules(retention.classes, 'retention');
  requireAuditRetention(retention.auditReceiptMilliseconds, 'retention');
  const deletionBoundMilliseconds =
    input.deletionBoundMilliseconds ?? DEFAULT_DELETION_BOUND_MILLISECONDS;
  requirePositive(deletionBoundMilliseconds, 'deletionBoundMilliseconds');
  const tenants = input.tenants ?? {};
  validateTenants(tenants);
  return Object.freeze({
    revision: input.revision,
    admission,
    recall,
    retention,
    deletionBoundMilliseconds,
    tenants,
  });
}

export interface ResolvedTenantPolicy {
  readonly deletionBoundMilliseconds: number;
  readonly retention: Readonly<Record<MemoryClass, MemoryRetentionRule>>;
  readonly auditReceiptMilliseconds: number;
}

/** The deletion bound, per-class retention, and audit retention in force for one tenant. */
export function resolveTenantPolicy(
  policy: MemoryGovernancePolicy,
  tenantId: string,
): ResolvedTenantPolicy {
  const override = policy.tenants[tenantId];
  return {
    deletionBoundMilliseconds:
      override?.deletionBoundMilliseconds ?? policy.deletionBoundMilliseconds,
    retention: { ...policy.retention.classes, ...override?.retention },
    auditReceiptMilliseconds:
      override?.auditReceiptMilliseconds ?? policy.retention.auditReceiptMilliseconds,
  };
}

export function trustAtLeast(actual: MemoryTrust, minimum: MemoryTrust): boolean {
  return MEMORY_TRUST_LEVELS.indexOf(actual) >= MEMORY_TRUST_LEVELS.indexOf(minimum);
}

export function lowestTrust(levels: readonly MemoryTrust[]): MemoryTrust {
  let lowest: MemoryTrust = 'system';
  for (const level of levels) {
    if (!trustAtLeast(level, lowest)) lowest = level;
  }
  return lowest;
}
