import {
  createToolbox,
  type InternalToolboxOptions,
  internalToolboxOptionsSymbol,
  type SerializedToolbox,
  type Toolbox,
  type ToolboxContext,
} from './create-toolbox';
import type { Tool } from './is-tool';

type ToolboxLike<TTools extends readonly Tool[] = readonly Tool[]> = {
  toJSON: () => SerializedToolbox;
  tools: () => TTools;
  getContext?: () => ToolboxContext;
};

/** The shape a real armorer-constructed toolbox carries under the symbol key. */
type WithInternalToolboxOptions = {
  [internalToolboxOptionsSymbol]?: InternalToolboxOptions;
};

type ToolsFromToolbox<TBox> = TBox extends ToolboxLike<infer TTools> ? TTools : readonly Tool[];

type ConcatenateTools<TBoxes extends readonly unknown[]> = TBoxes extends readonly [
  infer THead,
  ...infer TTail,
]
  ? [...ToolsFromToolbox<THead>, ...ConcatenateTools<TTail>]
  : [];

/**
 * Combine one or more Toolbox instances into a fresh Toolbox.
 *
 * - Tools are copied via `toJSON()` and provided to a new immutable toolbox.
 * - If multiple toolboxes define the same tool name, the **last** one wins.
 * - Contexts are shallow-merged in the same order (last one wins on key collisions).
 * - The **first** toolbox's own options — `policy`, `approvalPolicy`,
 *   `approvalSecret`, `approvalStateStore`, `grantStateStore`,
 *   `approvalBindingTtlMs`, `approvalNow`, `approvalNonce`, `readOnly`,
 *   `allowMutation`, `allowDangerous`, and everything else `ToolboxOptions`
 *   carries except `context` and `middleware` — are forwarded into the
 *   combined toolbox, the same way `Toolbox.extend()` already forwards its
 *   own options into an extended toolbox (`create-toolbox.ts`'s `extend()`,
 *   which spreads `{ ...options, ... }`). `middleware` is excluded because
 *   every configuration `toJSON()` returns has already been transformed by
 *   it at registration time; forwarding it here would apply it a second
 *   time to already-transformed input. Combining is not a merge of
 *   approval configuration across toolboxes: only the first toolbox's
 *   approval gating (including any `needs_approval` `policy.beforeExecute`
 *   hook, capability-tier `approvalPolicy`, and reusable-grant matching,
 *   which only ever runs when `approvalPolicy` is configured) governs
 *   calls to the combined toolbox. Losing this silently would mean
 *   approval gating — and any pending review or reusable-grant matching
 *   built on it — disappears for every tool call routed through the
 *   combination (AB-362).
 */
export function combineToolboxes<const TBoxes extends readonly [ToolboxLike, ...ToolboxLike[]]>(
  ...toolboxes: TBoxes
): Toolbox<ConcatenateTools<TBoxes>> {
  if (toolboxes.length === 0) {
    throw new TypeError('combineToolboxes() requires at least 1 Toolbox');
  }

  const context: ToolboxContext = {};
  for (const toolbox of toolboxes) {
    const ctx = toolbox.getContext?.();
    if (ctx && typeof ctx === 'object') {
      Object.assign(context, ctx);
    }
  }

  const [firstToolbox] = toolboxes;
  // Reads the first toolbox's approval-related options off a
  // module-private symbol key, never a public accessor — see
  // `internalToolboxOptionsSymbol`'s own doc comment in `create-toolbox.ts`
  // for why (AB-362 review finding: exposing `approvalSecret` on the
  // public `Toolbox` interface would let any caller holding a toolbox
  // reference read it straight off the object) and why this must be a
  // symbol-keyed property rather than a `WeakMap` keyed by the toolbox
  // instance (a `WeakMap` lookup misses when the toolbox bureau hands in
  // has been wrapped in a `Proxy`, as `withDefaultToolboxRequestContext`
  // does — a symbol property survives that because the proxy's `get` trap
  // forwards unrecognized property reads, symbol keys included, straight
  // to the underlying target). `firstToolbox` is typed as the minimal
  // structural `ToolboxLike`, which declares no symbol index signature —
  // the cast to `WithInternalToolboxOptions` only adds that one optional
  // symbol-keyed field, so a toolbox this package didn't construct (a
  // duck-typed `ToolboxLike` from a test double, say) simply reads
  // `undefined` off it, falling back to `{}` exactly like the removed
  // optional-method call it replaced.
  const firstToolboxOptions =
    (firstToolbox as WithInternalToolboxOptions)[internalToolboxOptionsSymbol] ?? {};

  const configurations = toolboxes.flatMap((toolbox) => toolbox.toJSON());
  // `createToolbox`'s return type is inferred from the runtime-flattened
  // `configurations` array, which loses the tuple-level per-toolbox typing
  // `ConcatenateTools<TBoxes>` reconstructs at the type level — the two
  // shapes are runtime-identical but structurally distinct to TypeScript,
  // so the cast (pre-existing, not introduced by AB-362) is required.
  return createToolbox(configurations, {
    ...firstToolboxOptions,
    context,
  }) as unknown as Toolbox<ConcatenateTools<TBoxes>>;
}
