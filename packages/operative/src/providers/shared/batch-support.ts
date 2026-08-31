import { ProviderError } from '../errors.ts';
import type { ProviderName } from '../types.ts';

/**
 * What one provider's batch factory needs from its optional peer SDK, and the
 * first release that shipped it.
 *
 * Each `minimumVersion` below was established empirically — every candidate
 * release downloaded from the npm registry and its *published declarations*
 * read — rather than from changelog prose:
 *
 * - `openai`: `client.batches` first appears in **4.34.0** (2024-04-15) with
 *   `create`/`retrieve`/`cancel` only. `list`, which `OpenAIBatchOperations`
 *   advertises, first appears in **4.38.0** (2024-04-18), so 4.38.0 is the real
 *   floor for this package's surface. The declared peer range stays `>=4.0.0`
 *   on purpose: raising it would penalise every chat-only consumer for a
 *   feature they may never import. This guard closes that gap instead.
 * - `@anthropic-ai/sdk`: stable `client.messages.batches`, with all five
 *   methods this package calls, first appears in **0.33.0** — 0.30.0–0.32.0
 *   carried it only under `client.beta`. The declared peer floor is `>=0.50.0`,
 *   so unlike `openai` the range already admits no SDK without it.
 * - `@google/genai`: `client.batches` first appears in **1.7.0**. The declared
 *   peer floor is `>=2.19.0`, so that range already admits no SDK without it
 *   either.
 *
 * All three factories are guarded even though only `openai`'s declared range
 * can admit a broken install, because a peer range is a declaration and not an
 * enforcement: `--legacy-peer-deps`, a resolution override, or a hand-rolled
 * `client` can put any of these shapes in front of the factory. A guard that
 * fires for one provider and not the others would just make the failure mode
 * inconsistent.
 */
export interface BatchSurfaceRequirement {
  /** Provider name carried on the thrown {@link ProviderError}. */
  provider: ProviderName;
  /** npm package the client is expected to come from. */
  packageName: string;
  /** First release of `packageName` shipping every method in `methods`. */
  minimumVersion: string;
  /** Property path from the client root to the batch namespace. */
  path: readonly [string, ...string[]];
  /** The methods this package actually calls on that namespace. */
  methods: readonly string[];
}

/**
 * Narrows an `unknown` to something indexable, so the walk below reads
 * properties off a possibly-ancient SDK client without a cast. Class instances
 * pass, which matters because SDK methods live on the prototype.
 */
function isPropertyBag(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unsupportedBatchSurface(
  requirement: BatchSurfaceRequirement,
  detail: string,
): ProviderError {
  const { provider, packageName, minimumVersion } = requirement;
  return new ProviderError({
    provider,
    // A configuration fault with no underlying SDK error to carry. No status
    // code means `retryable: false`, which is right: retrying cannot install a
    // newer SDK.
    cause: undefined,
    message:
      `[provider:${provider}] batch operations require ${packageName} >= ${minimumVersion}, ` +
      `but ${detail}. Upgrade ${packageName}, or pass a \`client\` that implements the batch surface.`,
  });
}

/**
 * Throws a {@link ProviderError} unless `client` exposes the batch namespace
 * and methods `requirement` names.
 *
 * Called once per client rather than once per operation: an SDK too old to have
 * the resource fails identically on every call, so the useful moment to say so
 * is as soon as the client exists — at construction for an injected `client`,
 * and in the dynamic import's continuation for a lazily built one. Without
 * this, the symptom is `TypeError: Cannot read properties of undefined
 * (reading 'create')` on every operation, which names neither the cause nor
 * the fix.
 */
export function assertBatchSurface(client: unknown, requirement: BatchSurfaceRequirement): void {
  const { path, methods } = requirement;
  const dottedPath = `client.${path.join('.')}`;

  let namespace: unknown = client;
  for (const segment of path) {
    namespace = isPropertyBag(namespace) ? namespace[segment] : undefined;
  }

  if (!isPropertyBag(namespace)) {
    throw unsupportedBatchSurface(requirement, `${dottedPath} is not available on this client`);
  }

  const batchNamespace = namespace;
  const missingMethods = methods.filter((method) => typeof batchNamespace[method] !== 'function');

  if (missingMethods.length > 0) {
    const missingList = missingMethods.map((method) => `${method}()`).join(', ');
    throw unsupportedBatchSurface(requirement, `${dottedPath} is missing ${missingList}`);
  }
}
