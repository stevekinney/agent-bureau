/**
 * COR-851 — the Bureau validator catalog for durable goals.
 *
 * Mirrors `createAgentCatalog` (`agent-catalog.ts`): a fixed, frozen set built
 * once at construction, looked up by name. A goal persists only a validator's
 * serializable IDENTITY (name and version). The executable stays in-process
 * code registered here by name and version, never serialized, so recovery
 * resolves the pinned identity again on every use.
 *
 * Resolution never throws and never falls back to a different version: a
 * redeploy that dropped or bumped a validator is reported explicitly as
 * `missing` or `version-mismatch`, and the caller turns that into the
 * `unavailable` outcome COR-638 already defines.
 */

import { sha256HexSync } from '@lostgradient/cryptography';
import type { Validator, ValidatorIdentity } from '@lostgradient/operative';

/** The serializable description of a registered validator. */
export interface GoalValidatorDescriptor {
  readonly identity: ValidatorIdentity;
  /** Absent when the validator did not declare it; only `'deterministic'` satisfies a goal that requires it. */
  readonly determinism?: 'deterministic' | 'stochastic' | undefined;
  /** Lowercase hex sha-256 over the canonical descriptor without the digest. */
  readonly descriptorDigest: string;
}

export interface GoalValidatorCatalogEntry {
  readonly identity: ValidatorIdentity;
  readonly validator: Validator;
  readonly descriptor: GoalValidatorDescriptor;
}

export type GoalValidatorResolution =
  | { readonly ok: true; readonly entry: GoalValidatorCatalogEntry }
  | {
      readonly ok: false;
      readonly reason: 'missing';
      readonly requested: ValidatorIdentity;
      /** Always empty: no version of this name is registered. */
      readonly availableVersions: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'version-mismatch';
      readonly requested: ValidatorIdentity;
      /** Every registered version of the requested name, in registration order. */
      readonly availableVersions: readonly string[];
    };

export interface GoalValidatorCatalog {
  /** Exact `(name, version)` lookup. Accepts runtime values: anything that is not a registered identity is `missing`. */
  resolve(identity: { readonly name: unknown; readonly version: unknown }): GoalValidatorResolution;
  has(identity: { readonly name: unknown; readonly version: unknown }): boolean;
  /** The serializable descriptors, in registration order. */
  descriptors(): GoalValidatorDescriptor[];
  entries(): GoalValidatorCatalogEntry[];
}

function describeValidator(validator: Validator): GoalValidatorDescriptor {
  const { name, version } = validator.identity;
  const determinism = validator.determinism;
  const body = { identity: { name, version }, determinism: determinism ?? null };
  const descriptorDigest = sha256HexSync(JSON.stringify(body));
  return Object.freeze({
    identity: Object.freeze({ name, version }),
    ...(determinism === undefined ? {} : { determinism }),
    descriptorDigest,
  });
}

/**
 * Decodes a descriptor read back from storage or a wire. Fail-closed: `undefined`
 * unless the value is exactly a descriptor whose digest matches its own contents.
 */
export function decodeGoalValidatorDescriptor(value: unknown): GoalValidatorDescriptor | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !Object.keys(record).every((key) =>
      ['identity', 'determinism', 'descriptorDigest'].includes(key),
    )
  ) {
    return undefined;
  }
  const identity = record['identity'] as Record<string, unknown> | null;
  const determinism = record['determinism'];
  if (
    typeof identity !== 'object' ||
    identity === null ||
    typeof identity['name'] !== 'string' ||
    typeof identity['version'] !== 'string' ||
    (determinism !== undefined && determinism !== 'deterministic' && determinism !== 'stochastic')
  ) {
    return undefined;
  }
  const expected = describeValidator({
    identity: { name: identity['name'], version: identity['version'] },
    determinism,
    validate: () => ({ kind: 'canceled' }),
  });
  return record['descriptorDigest'] === expected.descriptorDigest ? expected : undefined;
}

/**
 * Builds the immutable catalog over a fixed list of validators. Throws at
 * construction for a validator with no usable identity and for two validators
 * registered under the same `(name, version)`: both are programming errors a
 * bureau should refuse to start with.
 */
export function createGoalValidatorCatalog(
  validators: readonly Validator[] = [],
): GoalValidatorCatalog {
  const entries: GoalValidatorCatalogEntry[] = [];
  const byName = new Map<string, Map<string, GoalValidatorCatalogEntry>>();
  for (const validator of validators) {
    const { name, version } =
      (validator as { identity?: Partial<ValidatorIdentity> }).identity ?? {};
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      typeof version !== 'string' ||
      version.length === 0 ||
      typeof validator.validate !== 'function'
    ) {
      throw new TypeError(
        'Bureau goal validators require a non-empty identity name and version and a validate() function.',
      );
    }
    const versions = byName.get(name) ?? new Map<string, GoalValidatorCatalogEntry>();
    if (versions.has(version)) {
      throw new Error(`Bureau goal validator "${name}@${version}" is registered more than once.`);
    }
    const descriptor = describeValidator(validator);
    const entry = Object.freeze({ identity: descriptor.identity, validator, descriptor });
    versions.set(version, entry);
    byName.set(name, versions);
    entries.push(entry);
  }

  const resolve: GoalValidatorCatalog['resolve'] = (identity) => {
    const name = typeof identity.name === 'string' ? identity.name : '';
    const version = typeof identity.version === 'string' ? identity.version : '';
    const requested = Object.freeze({ name, version });
    const versions = byName.get(name);
    if (versions === undefined) {
      return { ok: false, reason: 'missing', requested, availableVersions: [] };
    }
    const entry = versions.get(version);
    if (entry === undefined) {
      return {
        ok: false,
        reason: 'version-mismatch',
        requested,
        availableVersions: [...versions.keys()],
      };
    }
    return { ok: true, entry };
  };

  return Object.freeze({
    resolve,
    has: (identity: Parameters<typeof resolve>[0]) => resolve(identity).ok,
    descriptors: () => entries.map((entry) => entry.descriptor),
    entries: () => [...entries],
  });
}
