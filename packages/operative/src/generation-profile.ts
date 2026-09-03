/**
 * The Agent generation profile — an immutable per-Agent capability snapshot
 * (AB-64's decision record, implemented by AB-245).
 *
 * Every `RunnableAgent` optionally carries a `generationProfile`: which
 * `BackendDescriptor`(s) sit behind its `GenerateFunction`, in which of the
 * four `GenerationMode`s (`fixed`, `routed`, `selectable`, `opaque`), and
 * whether a selector is available to act on it. `readGenerationProfile`
 * reads it (or a frozen default) without ever loading a lazy module,
 * contacting a provider, or starting background work — see
 * `create-agent.ts`, `create-lazy-agent.ts`, and `create-lazy-generate.ts`
 * for where a profile gets built and attached.
 *
 * `AgentPreferences` is defined here — not in Bureau's not-yet-built
 * `policy.ts` (AB-66) — because AB-64's decision record fixes it as the
 * Agent-requirements-and-preferences layer of the five-layer precedence
 * model, and `policy.ts` imports it from here rather than redefining it.
 */

import type { BackendDescriptor, CatalogProjection } from './providers/model-catalog.ts';
import type { ProviderName } from './providers/types.ts';
import type { RunnableAgent } from './runnable-agent.ts';

/**
 * How an Agent's generation backend is determined:
 *
 * - `fixed`: exactly one `BackendDescriptor` is attached to the agent's
 *   `GenerateFunction` — a single provider factory, e.g. `createAnthropicProvider`.
 * - `routed`: more than one is attached — `createRoutingGenerate`'s
 *   in-call choice among several configured routes.
 * - `selectable`: the agent supplied `allowedCandidates` (`create-agent.ts`),
 *   naming candidates a future selector (AB-66) may choose among. Until
 *   AB-66 ships, `selector` always reads `'unavailable'` here — a
 *   `createAgent` agent has no Bureau, no policy configuration, and no
 *   catalog, so it can never select (AB-64's verification walk).
 * - `opaque`: no descriptor is attached at all — a custom `GenerateFunction`
 *   this package cannot introspect. Never invented; an `opaque` generator
 *   reporting a descriptor it was never given is this feature's rollback
 *   trigger.
 */
export type GenerationMode = 'fixed' | 'routed' | 'selectable' | 'opaque';

/**
 * The Agent-requirements-and-preferences layer of AB-64's five-layer
 * precedence model (`## Precedence model and user configuration (AC3, AC4)`).
 * Expresses needs and preferences only — never denials; a missing required
 * capability excludes a candidate with `missing-required-capability`
 * (AB-66's selector, not this issue). AB-52's `DelegatedAuthority` narrows by
 * omission and is a distinct, later layer.
 */
export interface AgentPreferences {
  readonly requiredCapabilities?: readonly (keyof BackendDescriptor)[];
  readonly preferredProviders?: readonly ProviderName[];
  readonly preferredModels?: readonly string[];
  readonly minimumContextWindowTokens?: number;
}

/**
 * The immutable capability snapshot behind one `RunnableAgent`, per AB-64's
 * decision record. `projection` is `'privileged'` for a profile read
 * directly off an agent — the caller already holds the `GenerateFunction`
 * and therefore its descriptors; AB-247 (mod-02e) stamps `'general'` on the
 * Bureau catalog read instead.
 */
export interface AgentGenerationProfile {
  readonly mode: GenerationMode;
  readonly revision: number;
  readonly projection: CatalogProjection;
  readonly descriptors: readonly BackendDescriptor[];
  readonly preferences?: AgentPreferences;
  readonly allowedCandidates?: readonly {
    readonly provider: ProviderName;
    readonly model: string;
  }[];
  readonly freshness: string;
  readonly selector: 'available' | 'unavailable';
}

const EMPTY_DESCRIPTORS: readonly BackendDescriptor[] = Object.freeze([]);

/**
 * The `mode: 'opaque'` profile `readGenerationProfile` returns for an agent
 * with no `generationProfile` of its own. A single frozen module-level
 * constant — never rebuilt per call — so repeated reads for two different
 * profile-less agents, and repeated reads for the SAME agent, both return
 * the identical object by reference. `freshness` is the Unix epoch rather
 * than the wall clock: there is no real descriptor data behind this
 * fallback, and reading `Date.now()` here would make this module's import
 * itself a (harmless but needless) clock read, at odds with "a capability
 * read never starts work".
 */
const DEFAULT_OPAQUE_PROFILE: AgentGenerationProfile = Object.freeze({
  mode: 'opaque',
  revision: 1,
  projection: 'privileged',
  descriptors: EMPTY_DESCRIPTORS,
  freshness: new Date(0).toISOString(),
  selector: 'unavailable',
});

/**
 * Reads `agent`'s generation profile: its own `generationProfile` when
 * present, otherwise the frozen `DEFAULT_OPAQUE_PROFILE`. Synchronous,
 * side-effect-free, and never loads a lazy module, contacts a provider, or
 * starts background work — it is a plain property read (or a constant),
 * nothing more. Repeated reads before a represented change return the
 * identical object by reference in both branches.
 */
export function readGenerationProfile(agent: RunnableAgent): AgentGenerationProfile {
  return agent.generationProfile ?? DEFAULT_OPAQUE_PROFILE;
}
