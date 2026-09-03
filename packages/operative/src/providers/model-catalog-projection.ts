/**
 * The `'general'`/`'privileged'` catalog projection (AB-64's Catalog
 * discipline, `## Catalog discipline (AC8)`, implemented by AB-247/mod-02e).
 *
 * `'privileged'` returns a `BackendDescriptor`/`ModelCatalog` unchanged in
 * substance. `'general'` redacts exactly what AC8 names: pricing figures
 * omitted entirely; the endpoint reduced to its bare operation name with any
 * host or origin detail stripped; `endpointAmbiguous` omitted, because it
 * discloses that a custom base URL or proxy is configured; and any
 * account-level quota field omitted (`BackendDescriptor` has none today —
 * `GENERAL_PROJECTION_REDACTED_KEYS` and
 * `model-catalog-projection.test.ts`'s exhaustive key-enumeration test are
 * the guard that catches one added later without a redaction decision).
 * `availability`, `health`, `source`, and `freshness` are retained
 * deliberately: a caller must still be able to tell an unavailable backend
 * from an available one.
 *
 * Both `projectDescriptor` and `projectCatalog` are synchronous, pure
 * functions of their arguments — no environment read, no clock read, no
 * network input or output — and return deeply frozen values.
 */

import { deepFreeze } from './backend-descriptor-attachment.ts';
import type { BackendDescriptor, CatalogProjection, ModelCatalog } from './model-catalog.ts';

/**
 * The exact `BackendDescriptor` keys the `'general'` projection omits.
 * Exported so `model-catalog-projection.test.ts` can enumerate every key of
 * `BackendDescriptor` and assert each one is either present in a `'general'`
 * projection or named here — a field added to the descriptor later without a
 * redaction decision fails that test rather than silently being exposed.
 */
export const GENERAL_PROJECTION_REDACTED_KEYS: readonly (keyof BackendDescriptor)[] = Object.freeze(
  ['pricing', 'endpointAmbiguous'],
);

/**
 * Reduces an `endpoint` value to its bare operation name, stripping any
 * scheme, host, or origin detail. Every seed row `createModelCatalog` builds
 * already stores a bare operation name (`'messages'`, `'chat.completions'`,
 * `'generateContent'`) with no host component, so this is a no-op for them;
 * it exists to make the `'general'` projection's redaction genuinely
 * structural — enforced by transformation, not merely true by convention —
 * against a future descriptor row whose `endpoint` happens to be URL-shaped.
 *
 * Never falls back to any host-derived value: a URL with no path component
 * (`'https://proxy.internal.example.com'`) returns `''`, not the hostname —
 * returning the hostname there would leak exactly the host/origin detail
 * this function exists to strip (review finding, PRRT_kwDORvupsc6e4ZXI). A
 * value that contains `'://'` but fails to parse as a URL also returns `''`
 * rather than the raw input, for the same reason: an unparseable string can
 * still carry host-shaped text, and this function's contract is "never
 * expose host/origin detail", not "best-effort strip it".
 */
function toBareOperationName(endpoint: string): string {
  if (!endpoint.includes('://')) return endpoint;
  try {
    const url = new URL(endpoint);
    return url.pathname.replace(/^\/+/, '');
  } catch {
    return '';
  }
}

/**
 * Projects one `BackendDescriptor` to `projection`. `'privileged'` returns a
 * deeply frozen structural copy — every field retained, nothing added.
 * `'general'` omits `GENERAL_PROJECTION_REDACTED_KEYS` and replaces
 * `endpoint` with {@link toBareOperationName}'s result.
 */
export function projectDescriptor(
  descriptor: BackendDescriptor,
  projection: CatalogProjection,
): BackendDescriptor {
  if (projection === 'privileged') {
    return deepFreeze({ ...descriptor });
  }
  // `pricing`/`endpointAmbiguous` are destructured out and left unused
  // deliberately — the rest pattern is what excludes them from `rest`, and
  // both are optional on `BackendDescriptor`, so `rest` (plus the
  // recomputed `endpoint`) is itself a valid `BackendDescriptor`.
  const { pricing, endpointAmbiguous, ...rest } = descriptor;
  return deepFreeze({
    ...rest,
    endpoint: toBareOperationName(descriptor.endpoint),
  });
}

/**
 * Projects every descriptor in `catalog` to `projection` and stamps the
 * result's own `projection` field, per AB-34's "a caller reads which
 * projection it received rather than inferring it" contract.
 * `catalog.stale`/`revision`/`generatedAt` pass through unchanged.
 */
export function projectCatalog(catalog: ModelCatalog, projection: CatalogProjection): ModelCatalog {
  const descriptors = Object.freeze(
    catalog.descriptors.map((descriptor) => projectDescriptor(descriptor, projection)),
  );
  return deepFreeze({
    ...catalog,
    descriptors,
    projection,
  });
}
