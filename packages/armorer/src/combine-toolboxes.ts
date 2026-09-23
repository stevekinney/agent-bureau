import { createToolbox } from './create-toolbox';
import type { Tool } from './is-tool';
import type { SerializedToolbox, ToolboxContext } from './toolbox-contracts';
import type { Toolbox } from './toolbox-interface';
import { internalToolboxOptionsRegistry } from './toolbox-internal-registry';

type ToolboxLike<TTools extends readonly Tool[] = readonly Tool[]> = {
  toJSON: () => SerializedToolbox;
  tools: () => TTools;
  getContext?: () => ToolboxContext;
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
 * - The **first** toolbox's approval- and toolbox-identity-related options —
 *   `policy` (including any `needs_approval` `beforeExecute` hook) together
 *   with the `policyContext` that hook reads its tenant/approval-context
 *   values from,
 *   `approvalPolicy`, `approvalSecret`, `approvalStateStore`,
 *   `grantStateStore`, `approvalBindingTtlMs`, `approvalNow`,
 *   `approvalNonce`, `policyRevision`, `approvalRevision`,
 *   `toolboxRevision`, `readOnly`, `allowMutation`, and `allowDangerous` —
 *   are forwarded into the combined toolbox, the same way `Toolbox.extend()`
 *   already forwards its own options into an extended toolbox
 *   (`create-toolbox.ts`'s `extend()`). This is a narrow, explicit
 *   allowlist (`InternalToolboxOptions` in `create-toolbox.ts`), not every
 *   option `ToolboxOptions` carries: `middleware` is excluded because
 *   every configuration `toJSON()` returns has already been transformed by
 *   it at registration time, so forwarding it again would apply it a
 *   second time to already-transformed input; `signal` is excluded because
 *   it would tie the combined toolbox's abort listener to a signal it
 *   never gets a chance to detach from on normal completion, accumulating
 *   listeners across repeated short-lived combinations under one
 *   long-lived signal (both AB-362 review findings). Combining is not a
 *   merge of approval configuration across toolboxes: only the first
 *   toolbox's approval gating (including any `needs_approval`
 *   `policy.beforeExecute` hook, capability-tier `approvalPolicy`, and
 *   reusable-grant matching, which only ever runs when `approvalPolicy`
 *   is configured) governs calls to the combined toolbox. Losing this
 *   silently would mean approval gating — and any pending review or
 *   reusable-grant matching built on it — disappears for every tool call
 *   routed through the combination (AB-362).
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
  // Read resolved private options keyed by the stable `toJSON` method. See
  // `toolbox-internal-registry.ts` for the ownership and security rationale.
  const firstToolboxOptions = internalToolboxOptionsRegistry.get(firstToolbox.toJSON) ?? {};

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
