/**
 * Type-level regression test: `AnthropicProviderOptions.thinking` must stay a
 * faithful structural mirror of the Anthropic SDK's own `ThinkingConfigParam`.
 *
 * Why this file exists: `thinking` is documented as a *native-shaped* escape
 * hatch, but its first revision declared only `enabled | disabled` while the
 * SDK's union has always had a third variant, `{ type: 'adaptive' }` (plus an
 * optional `display` field on two of the three). A native-shaped option that
 * silently narrows the native shape is worse than no option at all: adaptive
 * thinking became unreachable through `createAnthropicProvider` without
 * defeating the type system. Nothing caught it, because "mirrors the SDK" was
 * only ever a claim in a doc comment. These assertions turn it into a
 * compile-time fact.
 *
 * The two directions check different failures:
 *
 * - `SdkAssignableToOption` fails when the SDK *widens* — a fourth variant, or
 *   a new field on an existing one, lands upstream and this package's option
 *   would quietly make it unreachable. This is the anti-narrowing pin.
 * - `OptionAssignableToSdk` fails when this package *drifts* — a variant or
 *   field is invented here that Anthropic would reject on the wire.
 *
 * Deliberately no `import type { ThinkingConfigParam }` in `types.ts` itself:
 * `@anthropic-ai/sdk` is an *optional* peer dependency, so referencing its
 * types from a published declaration would break every consumer who does not
 * install it. The dependency belongs here, in a file `tsconfig.build.json`
 * excludes by suffix, exactly as `batch-client-assignability.test-d.ts` does
 * for the SDK client shapes. It declares only types, so it is erased entirely
 * and contributes no coverage.
 */
import type { Anthropic } from '@anthropic-ai/sdk';

import type { AnthropicThinkingConfig } from './types.ts';

/** Fails to compile unless `T` resolves to exactly `true`. */
type Assert<T extends true> = T;

/** Every variant Anthropic accepts is expressible through this package's option. */
export type SdkAssignableToOption = Assert<
  Anthropic.Messages.ThinkingConfigParam extends AnthropicThinkingConfig ? true : false
>;

/** This package's option invents nothing the SDK would reject. */
export type OptionAssignableToSdk = Assert<
  AnthropicThinkingConfig extends Anthropic.Messages.ThinkingConfigParam ? true : false
>;

/**
 * The variant whose absence was the original defect, pinned on its own so a
 * regression names itself rather than failing as an opaque union mismatch.
 */
export type AdaptiveVariantIsReachable = Assert<
  Anthropic.Messages.ThinkingConfigAdaptive extends AnthropicThinkingConfig ? true : false
>;
