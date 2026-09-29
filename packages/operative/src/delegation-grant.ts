/**
 * Delegation grants — COR-336's binding decision record, first implemented
 * for COR-772 (durable parent-child topology in Bureau).
 *
 * A `DelegationGrant` is the authority record for exactly one child
 * dispatch. It binds the parent and child run identities, the selected
 * agent and its version, the objective (or an approved-artifact digest),
 * the child's effective capabilities, its derived budget ceilings, its
 * remaining nesting depth, the policy version, and its issue and expiry
 * times. It is signed with the same HMAC-SHA-256 primitive armorer's
 * reusable approval grants use, over a canonical serialization, so the
 * record is tamper-evident outside model reasoning: a natural-language
 * claim that authority exists is never the authority record.
 *
 * What this module deliberately is not:
 *
 * - It is not a store. Durable persistence, the reserve/release budget
 *   ledger, and restart re-verification belong to the dispatcher that owns
 *   a durable topology (Bureau's `child-topology.ts`).
 * - It does not count usage. Budget ceilings are issuance terms and are
 *   signed; how much of a ceiling is currently consumed is a live counter
 *   the owning store derives from its ledger, never a signed field (the
 *   defect armorer's `usesRemaining` history documents).
 * - Revocation is not tampering. `revoked` is signed like every other
 *   field, and {@link revokeDelegationGrant} re-signs the record, so a
 *   revoked grant fails verification as `revoked` while flipping the flag
 *   back without the secret fails as `invalid-signature`.
 *
 * Every dimension narrows monotonically: allow-lists intersect (an absent
 * side narrows nothing), switches can only be turned off, and numeric
 * ceilings take the lower value. No helper here can widen what an ancestor
 * granted.
 */

import { hmacSha256HexSync, sha256HexSync, timingSafeEqualHex } from '@lostgradient/cryptography';

import { isDelegatedAuthority } from './child-run';
import type { DelegatedAuthority } from './providers/policy.ts';

/** The compatibility boundary for the signed payload's shape. */
export const DELEGATION_GRANT_VERSION = 1 as const;

/**
 * The capability dimensions a grant narrows. Every list is an allow-list;
 * `network` and `admin` additionally accept a switch, where `false` denies
 * the whole dimension and `true` leaves it unrestricted.
 */
export interface DelegationCapabilities {
  readonly tools?: readonly string[] | undefined;
  readonly pathPatterns?: readonly string[] | undefined;
  readonly network?: readonly string[] | boolean | undefined;
  readonly secrets?: readonly string[] | undefined;
  readonly admin?: readonly string[] | boolean | undefined;
}

/**
 * The numeric budget ceilings a grant carries. An absent dimension is
 * inherited unchanged, never widened. Remaining nesting depth is the
 * grant's own top-level `depth`, not a budget dimension.
 */
export interface DelegationBudget {
  readonly concurrentChildren?: number | undefined;
  readonly totalDescendants?: number | undefined;
  readonly duration?: number | undefined;
  readonly steps?: number | undefined;
  readonly tokens?: number | undefined;
  readonly cost?: number | undefined;
  readonly toolCalls?: number | undefined;
}

/** How much of a grant a child-creation result may disclose. */
export type DelegationDisclosurePolicy = 'full' | 'redacted' | 'digest-only';

export interface DelegationGrant {
  readonly version: typeof DELEGATION_GRANT_VERSION;
  readonly id: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly agentName: string;
  readonly agentVersion: string;
  /** Metadata, never an authority claim — see this module's doc comment. */
  readonly objective: string;
  readonly recipientId: string;
  readonly effectiveCapabilities: DelegationCapabilities;
  /** The existing provider/model/effort narrowing, composed unchanged. */
  readonly delegatedAuthority: DelegatedAuthority;
  readonly budget: DelegationBudget;
  /** Remaining nesting levels below this grant. `0` authorizes no further child. */
  readonly depth: number;
  readonly policyVersion: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revoked: boolean;
  /** Present when `objective` names an approved artifact rather than free text. */
  readonly artifactDigest?: string | undefined;
  readonly disclosurePolicy: DelegationDisclosurePolicy;
  /** HMAC-SHA-256 over every other field, canonically serialized. */
  readonly signature: string;
}

export type UnsignedDelegationGrant = Omit<DelegationGrant, 'signature'>;

/** Why a grant is not currently valid authority. Each one is a hard deny. */
export type DelegationGrantVerificationCode =
  'unsupported-version' | 'invalid-signature' | 'revoked' | 'expired';

export type DelegationGrantVerification =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly code: DelegationGrantVerificationCode;
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * JSON with object keys sorted at every depth and `undefined` members
 * dropped, so the same logical grant always serializes identically no
 * matter how it was constructed or which process decoded it.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A SHA-256 hex digest of `value`'s canonical JSON form. */
export function digestDelegationArtifact(value: unknown): string {
  return sha256HexSync(canonicalJson(value));
}

function computeSignature(grant: UnsignedDelegationGrant, secret: string): string {
  const { signature: _signature, ...payload } = grant as DelegationGrant;
  return hmacSha256HexSync(secret, canonicalJson(payload));
}

// ---------------------------------------------------------------------------
// Signing, verification, revocation
// ---------------------------------------------------------------------------

/** Signs `grant`'s canonical payload with `secret`. */
export function signDelegationGrant(
  grant: UnsignedDelegationGrant,
  secret: string,
): DelegationGrant {
  return { ...grant, signature: computeSignature(grant, secret) };
}

/**
 * Checks, in order, the version, the signature, revocation, and expiry.
 * Version first because an unknown payload shape cannot be meaningfully
 * re-signed; signature before revocation and expiry because neither flag
 * can be trusted from a record that has been altered.
 */
export function verifyDelegationGrant(
  grant: DelegationGrant,
  secret: string,
  now: number,
): DelegationGrantVerification {
  if (grant.version !== DELEGATION_GRANT_VERSION) {
    return {
      valid: false,
      code: 'unsupported-version',
      reason: `Delegation grant ${grant.id} uses unsupported version ${String(grant.version)}.`,
    };
  }
  if (!timingSafeEqualHex(grant.signature, computeSignature(grant, secret))) {
    return {
      valid: false,
      code: 'invalid-signature',
      reason: `Delegation grant ${grant.id} does not match its signature.`,
    };
  }
  if (grant.revoked) {
    return { valid: false, code: 'revoked', reason: `Delegation grant ${grant.id} is revoked.` };
  }
  if (now >= grant.expiresAt) {
    return { valid: false, code: 'expired', reason: `Delegation grant ${grant.id} has expired.` };
  }
  return { valid: true };
}

/** Returns `grant` revoked and re-signed. Idempotent in effect. */
export function revokeDelegationGrant(grant: DelegationGrant, secret: string): DelegationGrant {
  const { signature: _signature, ...unsigned } = grant;
  return signDelegationGrant({ ...unsigned, revoked: true }, secret);
}

// ---------------------------------------------------------------------------
// Structural guard
// ---------------------------------------------------------------------------

const DISCLOSURE_POLICIES: readonly string[] = ['full', 'redacted', 'digest-only'];
const BUDGET_DIMENSIONS = [
  'concurrentChildren',
  'totalDescendants',
  'duration',
  'steps',
  'tokens',
  'cost',
  'toolCalls',
] as const satisfies readonly (keyof DelegationBudget)[];

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalStringList(value: unknown): boolean {
  return value === undefined || isStringList(value);
}

function isOptionalSwitchOrList(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean' || isStringList(value);
}

function isCapabilities(value: unknown): value is DelegationCapabilities {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isOptionalStringList(candidate['tools']) &&
    isOptionalStringList(candidate['pathPatterns']) &&
    isOptionalStringList(candidate['secrets']) &&
    isOptionalSwitchOrList(candidate['network']) &&
    isOptionalSwitchOrList(candidate['admin'])
  );
}

function isBudget(value: unknown): value is DelegationBudget {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return BUDGET_DIMENSIONS.every((dimension) => {
    const ceiling = candidate[dimension];
    return (
      ceiling === undefined ||
      (typeof ceiling === 'number' && Number.isFinite(ceiling) && ceiling >= 0)
    );
  });
}

/**
 * Structural guard for a grant read back from storage. Fails closed: any
 * field of the wrong type rejects the whole record, so a truncated or
 * hostile record is never mistaken for authority.
 */
export function isDelegationGrant(value: unknown): value is DelegationGrant {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const strings = [
    'id',
    'parentRunId',
    'childRunId',
    'agentName',
    'agentVersion',
    'objective',
    'recipientId',
    'policyVersion',
    'signature',
  ];
  const depth = candidate['depth'];
  const artifactDigest = candidate['artifactDigest'];
  return (
    candidate['version'] === DELEGATION_GRANT_VERSION &&
    strings.every((field) => typeof candidate[field] === 'string') &&
    typeof depth === 'number' &&
    Number.isInteger(depth) &&
    depth >= 0 &&
    typeof candidate['issuedAt'] === 'number' &&
    typeof candidate['expiresAt'] === 'number' &&
    typeof candidate['revoked'] === 'boolean' &&
    DISCLOSURE_POLICIES.includes(candidate['disclosurePolicy'] as string) &&
    (artifactDigest === undefined || typeof artifactDigest === 'string') &&
    isCapabilities(candidate['effectiveCapabilities']) &&
    isBudget(candidate['budget']) &&
    isDelegatedAuthority(candidate['delegatedAuthority'])
  );
}

// ---------------------------------------------------------------------------
// Monotonic attenuation
// ---------------------------------------------------------------------------

function intersectList(
  parent: readonly string[] | undefined,
  requested: readonly string[] | undefined,
): readonly string[] | undefined {
  if (parent === undefined) return requested;
  if (requested === undefined) return parent;
  return parent.filter((item) => requested.includes(item));
}

function intersectSwitchOrList(
  parent: readonly string[] | boolean | undefined,
  requested: readonly string[] | boolean | undefined,
): readonly string[] | boolean | undefined {
  if (parent === undefined || parent === true) return requested ?? parent;
  if (requested === undefined || requested === true) return parent;
  if (parent === false || requested === false) return false;
  return intersectList(parent, requested);
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}

/**
 * The child's effective capabilities: never wider than `parent` in any
 * dimension. `parent === undefined` (a top-level dispatch, with no grant
 * above it) returns `requested` unchanged.
 */
export function attenuateDelegationCapabilities(
  parent: DelegationCapabilities | undefined,
  requested: DelegationCapabilities | undefined,
): DelegationCapabilities {
  return withoutUndefined({
    tools: intersectList(parent?.tools, requested?.tools),
    pathPatterns: intersectList(parent?.pathPatterns, requested?.pathPatterns),
    network: intersectSwitchOrList(parent?.network, requested?.network),
    secrets: intersectList(parent?.secrets, requested?.secrets),
    admin: intersectSwitchOrList(parent?.admin, requested?.admin),
  });
}

/** The lower of each ceiling; an absent side inherits the other unchanged. */
export function attenuateDelegationBudget(
  parent: DelegationBudget | undefined,
  requested: DelegationBudget | undefined,
): DelegationBudget {
  const budget: Record<string, number | undefined> = {};
  for (const dimension of BUDGET_DIMENSIONS) {
    const inherited = parent?.[dimension];
    const asked = requested?.[dimension];
    budget[dimension] =
      inherited === undefined
        ? asked
        : asked === undefined
          ? inherited
          : Math.min(inherited, asked);
  }
  return withoutUndefined(budget);
}
