import {
  createToolbox,
  type SerializedToolbox,
  type Toolbox,
  type ToolboxContext,
  type ToolboxOptions,
} from './create-toolbox';
import type { Tool } from './is-tool';

type ToolboxLike<TTools extends readonly Tool[] = readonly Tool[]> = {
  toJSON: () => SerializedToolbox;
  tools: () => TTools;
  getContext?: () => ToolboxContext;
  getOptions?: () => Omit<ToolboxOptions, 'context'>;
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
 *   carries except `context` — are forwarded into the combined toolbox,
 *   the same way `Toolbox.extend()` already forwards its own options into
 *   an extended toolbox (`create-toolbox.ts`'s `extend()`, which spreads
 *   `{ ...options, ... }`). Combining is not a merge of approval
 *   configuration across toolboxes: only the first toolbox's approval
 *   gating (including any `needs_approval` `policy.beforeExecute` hook,
 *   capability-tier `approvalPolicy`, and reusable-grant matching, which
 *   only ever runs when `approvalPolicy` is configured) governs calls to
 *   the combined toolbox. Losing this silently would mean approval
 *   gating — and any pending review or reusable-grant matching built on
 *   it — disappears for every tool call routed through the combination
 *   (AB-362).
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
  const firstToolboxOptions = firstToolbox.getOptions?.() ?? {};

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
