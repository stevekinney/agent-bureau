import { hmacSha256HexSync, timingSafeEqualHex } from 'interoperability';
import { createDefaultRuntimeServices } from 'lifecycle';

import type { JsonValue } from './core/serialization/json';
import { stableStringifyJson } from './core/serialization/json';
import type { ToolRequestContext } from './execution-context';

export const APPROVAL_BINDING_VERSION = 1 as const;

// `validateApprovalBinding` and `createProcessLocalApprovalStateStore` are
// standalone public utilities. `createToolbox` always supplies its own
// composed clock explicitly (`approvalNow()`); this process-local default
// only backs a caller who invokes either function directly without one
// (AB-92 AC4, AB-254).
const defaultApprovalRuntime = createDefaultRuntimeServices();

export type ApprovalBindingPayload = {
  version: typeof APPROVAL_BINDING_VERSION;
  principalId: string;
  tenantId: string;
  ownerId: string;
  authorizationRevision: string;
  capabilitiesRevision: string;
  audience: NonNullable<ToolRequestContext['audience']>;
  agentId: string;
  runId: string;
  toolboxRevision: string;
  toolDefinitionRevision: string;
  policyRevision: string;
  approvalRevision: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  replayScope: string;
};

export type ApprovalBindingContext = Pick<
  ApprovalBindingPayload,
  | 'principalId'
  | 'tenantId'
  | 'ownerId'
  | 'authorizationRevision'
  | 'capabilitiesRevision'
  | 'audience'
  | 'agentId'
  | 'runId'
  | 'toolboxRevision'
  | 'toolDefinitionRevision'
  | 'policyRevision'
  | 'approvalRevision'
>;

export type ApprovalState = 'issued' | 'consumed' | 'revoked';

export class ApprovalBindingError extends Error {
  constructor(
    message: string,
    readonly code:
      'invalid-binding' | 'expired' | 'revoked' | 'already-consumed' | 'not-found' | 'mismatch',
  ) {
    super(message);
    this.name = 'ApprovalBindingError';
  }
}

function assertFiniteTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApprovalBindingError(
      `Approval binding ${label} must be a finite number.`,
      'invalid-binding',
    );
  }
}

function validateApprovalClock(now: number): number {
  assertFiniteTimestamp(now, 'validation time');
  return now;
}

function snapshotApprovalBinding(binding: ApprovalBindingPayload): ApprovalBindingPayload {
  return Object.freeze({ ...binding });
}

export interface ApprovalStateStore {
  issue(binding: ApprovalBindingPayload): Promise<void>;
  reserve(
    binding: ApprovalBindingPayload,
    context?: Partial<ApprovalBindingContext>,
    now?: number,
  ): Promise<void>;
  commit(binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>): Promise<void>;
  release(binding: ApprovalBindingPayload): Promise<void>;
  consume(
    binding: ApprovalBindingPayload,
    context?: Partial<ApprovalBindingContext>,
    now?: number,
  ): Promise<void>;
  revoke(binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>): Promise<void>;
  state(
    binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>,
  ): Promise<ApprovalState | undefined>;
}

export function validateApprovalBinding(
  binding: ApprovalBindingPayload,
  context?: Partial<ApprovalBindingContext>,
  now = defaultApprovalRuntime.clock.now(),
): void {
  const requiredStringFields = [
    'principalId',
    'tenantId',
    'ownerId',
    'authorizationRevision',
    'capabilitiesRevision',
    'agentId',
    'runId',
    'toolboxRevision',
    'toolDefinitionRevision',
    'policyRevision',
    'approvalRevision',
    'nonce',
    'replayScope',
  ] as const;
  if (binding.version !== APPROVAL_BINDING_VERSION) {
    throw new ApprovalBindingError('Invalid approval binding payload.', 'invalid-binding');
  }
  const candidate = binding as unknown as Record<string, unknown>;
  if (
    requiredStringFields.some(
      (field) => typeof candidate[field] !== 'string' || candidate[field] === '',
    ) ||
    !['public', 'tenant', 'operator'].includes(candidate['audience'] as string) ||
    typeof candidate['issuedAt'] !== 'number' ||
    typeof candidate['expiresAt'] !== 'number'
  ) {
    throw new ApprovalBindingError('Invalid approval binding payload.', 'invalid-binding');
  }
  assertFiniteTimestamp(binding.issuedAt, 'issuedAt');
  assertFiniteTimestamp(binding.expiresAt, 'expiresAt');
  const validationTime = validateApprovalClock(now);
  if (binding.issuedAt >= binding.expiresAt) {
    throw new ApprovalBindingError('Invalid approval binding payload.', 'invalid-binding');
  }
  if (validationTime >= binding.expiresAt) {
    throw new ApprovalBindingError('Approval binding has expired.', 'expired');
  }
  for (const key of Object.keys(context ?? {}) as Array<keyof ApprovalBindingContext>) {
    if (context?.[key] !== undefined && context[key] !== binding[key]) {
      throw new ApprovalBindingError(`Approval binding ${key} does not match.`, 'mismatch');
    }
  }
}

/** Process-local, atomic single-use approval state. */
export function createProcessLocalApprovalStateStore(
  nowFunction = defaultApprovalRuntime.clock.now,
): ApprovalStateStore {
  const issued = new Map<string, ApprovalBindingPayload>();
  const reserved = new Map<string, ApprovalBindingPayload>();
  const terminal = new Map<
    string,
    {
      state: Exclude<ApprovalState, 'issued'>;
      expiresAt: number;
      binding?: ApprovalBindingPayload;
    }
  >();
  const keyOf = (binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>) =>
    `${binding.replayScope}\u0000${binding.nonce}`;
  const purgeExpired = (now: number) => {
    for (const [key, binding] of issued) {
      if (now >= binding.expiresAt) issued.delete(key);
    }
    for (const [key, entry] of terminal) {
      if (now >= entry.expiresAt) terminal.delete(key);
    }
  };

  return {
    issue(binding) {
      return Promise.resolve().then(() => {
        const now = validateApprovalClock(nowFunction());
        purgeExpired(now);
        validateApprovalBinding(binding, undefined, now);
        const key = keyOf(binding);
        if (issued.has(key) || terminal.has(key)) {
          throw new ApprovalBindingError(
            'Approval binding nonce has already been issued.',
            'already-consumed',
          );
        }
        if (reserved.has(key)) {
          throw new ApprovalBindingError(
            'Approval binding nonce has already been issued.',
            'already-consumed',
          );
        }
        issued.set(key, snapshotApprovalBinding(binding));
      });
    },
    reserve(binding, context, now = nowFunction()) {
      return Promise.resolve().then(() => {
        const validationTime = validateApprovalClock(now);
        validateApprovalBinding(binding, context, validationTime);
        purgeExpired(validationTime);
        const key = keyOf(binding);
        const terminalEntry = terminal.get(key);
        if (terminalEntry?.state === 'revoked')
          throw new ApprovalBindingError('Approval binding was revoked.', 'revoked');
        if (terminalEntry?.state === 'consumed') {
          throw new ApprovalBindingError(
            'Approval binding has already been consumed.',
            'already-consumed',
          );
        }
        const issuedBinding = issued.get(key);
        if (!issuedBinding)
          throw new ApprovalBindingError('Approval binding was not found.', 'not-found');
        if (stableStringifyJson(issuedBinding) !== stableStringifyJson(binding)) {
          throw new ApprovalBindingError(
            'Approval binding does not match the issued payload.',
            'mismatch',
          );
        }
        issued.delete(key);
        reserved.set(key, issuedBinding);
      });
    },
    commit(binding) {
      return Promise.resolve().then(() => {
        const key = keyOf(binding);
        const reservedBinding = reserved.get(key);
        if (!reservedBinding) {
          const terminalEntry = terminal.get(key);
          if (terminalEntry?.state === 'consumed') {
            throw new ApprovalBindingError(
              'Approval binding has already been consumed.',
              'already-consumed',
            );
          }
          if (terminalEntry?.state === 'revoked') {
            throw new ApprovalBindingError('Approval binding was revoked.', 'revoked');
          }
          throw new ApprovalBindingError('Approval binding was not found.', 'not-found');
        }
        reserved.delete(key);
        terminal.set(key, {
          state: 'consumed',
          expiresAt: reservedBinding.expiresAt,
          binding: reservedBinding,
        });
      });
    },
    release(binding) {
      return Promise.resolve().then(() => {
        const key = keyOf(binding);
        const reservedBinding = reserved.get(key);
        if (reservedBinding) {
          reserved.delete(key);
          issued.set(key, reservedBinding);
          return;
        }
        const terminalEntry = terminal.get(key);
        if (terminalEntry?.state === 'consumed') {
          terminal.delete(key);
          issued.set(key, terminalEntry.binding ?? snapshotApprovalBinding(binding));
        }
      });
    },
    consume(binding, context, now = nowFunction()) {
      return Promise.resolve().then(async () => {
        await this.reserve(binding, context, now);
        await this.commit(binding);
      });
    },
    revoke(binding) {
      return Promise.resolve().then(() => {
        const now = validateApprovalClock(nowFunction());
        purgeExpired(now);
        const key = keyOf(binding);
        const terminalEntry = terminal.get(key);
        if (terminalEntry?.state === 'consumed') {
          throw new ApprovalBindingError(
            'Approval binding has already been consumed.',
            'already-consumed',
          );
        }
        const issuedBinding = issued.get(key);
        if (!issuedBinding) {
          if (terminalEntry?.state === 'revoked') return;
          const reservedBinding = reserved.get(key);
          if (reservedBinding) {
            reserved.delete(key);
            terminal.set(key, { state: 'revoked', expiresAt: reservedBinding.expiresAt });
            return;
          }
          throw new ApprovalBindingError('Approval binding was not found.', 'not-found');
        }
        issued.delete(key);
        terminal.set(key, { state: 'revoked', expiresAt: issuedBinding.expiresAt });
      });
    },
    state(binding) {
      return Promise.resolve().then(() => {
        const now = validateApprovalClock(nowFunction());
        purgeExpired(now);
        const key = keyOf(binding);
        return issued.has(key) ? 'issued' : terminal.get(key)?.state;
      });
    },
  };
}

// Reusable approval grants (AB-46, AB-345). A grant lets a matching future
// tool call skip human review entirely; grant *matching* and issuance
// wiring belong to AB-346, this module only owns the type, storage, and
// signing primitives.

export const GRANT_VERSION = 1 as const;

export interface ReusableApprovalGrant {
  readonly version: typeof GRANT_VERSION;
  readonly id: string; // `grant:${nonce}`
  readonly principalId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  /** The agent definition this grant applies to; '*' matches any agent under the same principal. */
  readonly agentId: string;
  /** Tool name or a named operation family; exact match only. Pattern matching is scoped to `resourcePattern`. */
  readonly toolName: string;
  /** Glob-style pattern checked against a caller-declared resource field in the tool's arguments; absent means any resource. */
  readonly resourcePattern?: string;
  /** Zod-schema-shaped constraints checked against the resumed arguments using the same validation `resumeApproval` performs. */
  readonly argumentConstraints?: Record<string, unknown>;
  readonly scope: 'run' | 'session' | 'principal';
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly maxUses: number;
  readonly usesRemaining: number;
  readonly policyRevision: string; // reuses armorer's existing policyRevision
  readonly revoked: boolean;
  /** Whether this grant's authority is visible to a delegated child run. AB-52 owns the attenuation arithmetic. */
  readonly delegationBehavior: 'inherits-to-children' | 'does-not-propagate';
  readonly signature: string; // HMAC, same primitive as `signPendingApproval` (`create-toolbox.ts`)
}

export class GrantError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'invalid-signature',
  ) {
    super(message);
    this.name = 'GrantError';
  }
}

export interface GrantStateStore {
  issue(grant: ReusableApprovalGrant): Promise<void>;
  revoke(id: string): Promise<void>;
  get(id: string): Promise<ReusableApprovalGrant | undefined>;
  list(): Promise<ReusableApprovalGrant[]>;
  decrementUse(id: string): Promise<{ usesRemaining: number }>;
}

function grantSignaturePayload(
  grant: ReusableApprovalGrant,
): Omit<ReusableApprovalGrant, 'signature'> {
  const { signature: _signature, ...payload } = grant;
  return payload;
}

function normalizeGrantSignaturePayload(
  payload: Omit<ReusableApprovalGrant, 'signature'>,
): JsonValue {
  const serialized = JSON.stringify(payload);
  return JSON.parse(serialized) as JsonValue;
}

/** Signs a grant's canonical fields (every field but `signature`) with the same HMAC primitive `signPendingApproval` uses. */
export function signGrant(grant: ReusableApprovalGrant, secret: string): string {
  return hmacSha256HexSync(
    secret,
    stableStringifyJson(normalizeGrantSignaturePayload(grantSignaturePayload(grant))),
  );
}

/** Verifies a grant's signature against its current field values; throws `GrantError` with code `invalid-signature` on mismatch. */
export function verifyGrantSignature(grant: ReusableApprovalGrant, secret: string): void {
  if (!timingSafeEqualHex(grant.signature, signGrant(grant, secret))) {
    throw new GrantError('Reusable approval grant signature is invalid.', 'invalid-signature');
  }
}

/** Process-local, in-memory reusable-grant storage. Grant matching (AB-346) is layered on top of this. */
export function createProcessLocalGrantStateStore(): GrantStateStore {
  const grants = new Map<string, ReusableApprovalGrant>();

  return {
    issue(grant) {
      return Promise.resolve().then(() => {
        grants.set(grant.id, { ...grant, usesRemaining: grant.maxUses });
      });
    },
    revoke(id) {
      return Promise.resolve().then(() => {
        const grant = grants.get(id);
        if (!grant) return;
        grants.set(id, { ...grant, revoked: true });
      });
    },
    get(id) {
      return Promise.resolve().then(() => grants.get(id));
    },
    list() {
      return Promise.resolve().then(() => Array.from(grants.values()));
    },
    decrementUse(id) {
      return Promise.resolve().then(() => {
        const grant = grants.get(id);
        if (!grant) {
          throw new GrantError('Reusable approval grant was not found.', 'not-found');
        }
        const usesRemaining = Math.max(0, grant.usesRemaining - 1);
        grants.set(id, { ...grant, usesRemaining });
        return { usesRemaining };
      });
    },
  };
}
