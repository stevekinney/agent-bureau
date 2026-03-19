import {
  createToolbox,
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

  const configurations = toolboxes.flatMap((toolbox) => toolbox.toJSON());
  return createToolbox(configurations, { context }) as unknown as Toolbox<ConcatenateTools<TBoxes>>;
}

/**
 * @deprecated Use `combineToolboxes(...)` instead.
 */
export function combineToolbox<const TBoxes extends readonly [ToolboxLike, ...ToolboxLike[]]>(
  ...toolboxes: TBoxes
): Toolbox<ConcatenateTools<TBoxes>> {
  return combineToolboxes(...toolboxes);
}
