/**
 * Typed diagnostics for the Cloudflare storage adapters. Every binding
 * mismatch, unsupported API, and serialization failure the adapters can
 * detect throws one of these — never a generic `Error`, and never a silent
 * fallback to a different backend (AB-277's acceptance criteria).
 */

/** Which injected binding a {@link CloudflareBindingMismatchError} names. */
export type CloudflareBindingKind = 'sql' | 'r2Bucket' | 'vectorize';

/**
 * Thrown at adapter CONSTRUCTION time (before any I/O) when an injected
 * binding is missing a member the production adapter contract requires.
 * Naming the binding and the missing member lets a caller tell "I passed the
 * wrong binding" apart from any other failure, and never falls back to a
 * different backend — the caller gets a thrown diagnostic, not a silently
 * degraded adapter.
 */
/**
 * Validates that `binding` has a callable member for every name in `members`,
 * throwing the first missing one as a {@link CloudflareBindingMismatchError}.
 * Called at adapter CONSTRUCTION time, before any I/O — so a mismatched
 * binding is rejected before any OTHER injected binding is ever touched.
 * `binding` is deliberately typed `unknown`: it is exactly the caller-supplied
 * value under test here, which may not even be an object.
 */
export function assertBindingHasMembers(
  kind: CloudflareBindingKind,
  binding: unknown,
  members: readonly string[],
): void {
  // A structural runtime shape-check on an arbitrary caller-supplied value
  // has no type-guard-only alternative: the whole point is to validate a
  // value that might not match `Record<string, unknown>` at all. Bracket
  // notation (not a cast to a narrower interface) keeps every access honest
  // about reading through an index signature, per this package's
  // `noPropertyAccessFromIndexSignature` convention.
  const candidate = binding as Record<string, unknown> | null | undefined;
  for (const member of members) {
    const value = candidate?.[member];
    if (typeof value !== 'function') {
      throw new CloudflareBindingMismatchError(kind, member);
    }
  }
}

export class CloudflareBindingMismatchError extends Error {
  readonly code = 'CloudflareBindingMismatchError';
  readonly binding: CloudflareBindingKind;
  readonly missingMember: string;

  constructor(binding: CloudflareBindingKind, missingMember: string) {
    super(
      `Cloudflare ${binding} binding is missing required member "${missingMember}(...)". ` +
        `This binding does not satisfy the production adapter contract; it was not used, and no other binding was touched.`,
    );
    this.name = 'CloudflareBindingMismatchError';
    this.binding = binding;
    this.missingMember = missingMember;
  }
}

/**
 * Thrown when an adapter path the real Cloudflare runtime does not implement
 * is invoked. Named, actionable, and never a silent degradation: `api`
 * identifies the call, `reason` and `owningIssue` explain why it is
 * unsupported on this runtime rather than pretending the call succeeded.
 */
export class CloudflareUnsupportedApiError extends Error {
  readonly code = 'CloudflareUnsupportedApiError';
  readonly api: string;
  readonly reason: string;
  readonly owningIssue: string;

  constructor(options: { api: string; reason: string; owningIssue: string; cause?: unknown }) {
    super(
      `Cloudflare adapter API "${options.api}" is not supported on this runtime (${options.reason}, see ${options.owningIssue}).`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'CloudflareUnsupportedApiError';
    this.api = options.api;
    this.reason = options.reason;
    this.owningIssue = options.owningIssue;
  }
}

/**
 * Thrown when a value handed to the memory-record backend cannot be
 * serialized onto its SQLite JSON boundary (a non-finite vector component, or
 * metadata that round-trips through `JSON.stringify`/`JSON.parse` as a
 * different value than what was given). Thrown BEFORE any `sql.exec` runs, so
 * a serialization failure never produces a partial or truncated write —
 * `field` names exactly which part of the record failed.
 */
export class CloudflareSerializationError extends Error {
  readonly code = 'CloudflareSerializationError';
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`Cloudflare memory record serialization failed for field "${field}": ${detail}`);
    this.name = 'CloudflareSerializationError';
    this.field = field;
  }
}

/**
 * Thrown by the real-runtime lane's storage proxies when an operation is
 * still in flight (or begins) after the lane has been asked to stop. Reports
 * a typed cancellation outcome — never a generic Miniflare "instance
 * disposed" error — naming the method and namespace that were cancelled.
 */
export class CloudflareRuntimeLaneCancelledError extends Error {
  readonly code = 'CloudflareRuntimeLaneCancelledError';
  readonly method: string;
  readonly namespace: string;

  constructor(method: string, namespace: string) {
    super(
      `Cloudflare runtime lane operation "${method}" was cancelled (namespace "${namespace}").`,
    );
    this.name = 'CloudflareRuntimeLaneCancelledError';
    this.method = method;
    this.namespace = namespace;
  }
}
