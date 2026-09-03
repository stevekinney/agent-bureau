import {
  type AnyToolbox,
  createToolbox,
  type CreateToolOptions,
  type Tool,
  type ToolboxEntries,
  type ToolboxOptions,
} from '../../src';

/**
 * A toolbox with the legacy mutable `register`/`createTool` convenience that
 * `createToolboxBase` attaches at runtime under `isTestRuntime()`
 * (`packages/armorer/src/create-toolbox.ts`). That convenience is real
 * runtime behavior — it is intentionally not part of the public `Toolbox`
 * type, so tests that use it need a locally-typed view of the same object
 * rather than a cast at every call site.
 */
export type MutableToolbox = AnyToolbox & {
  /**
   * Typed loosely as `unknown[]` rather than `ToolboxEntries`
   * (`ToolConfiguration | Tool`, both of which require `identity`/`id`/
   * `display`): `registerConfiguration` in `src/create-toolbox.ts` derives
   * those fields itself from a friendly config shorthand at registration
   * time, so the strict `ToolboxEntries` type doesn't describe what this
   * legacy convenience actually accepts.
   */
  register: (...toolEntries: unknown[]) => MutableToolbox;
  /**
   * Typed loosely as `(configuration: unknown) => Tool` rather than
   * `Parameters<typeof createTool>[0]`: the latter picks a single overload
   * of `createTool`'s three, which collapses schema-based param inference
   * (destructuring a schema-typed param reads as `{}`) and the sync/async
   * metadata conditional return (widens to `NamedTool | Promise<NamedTool>`)
   * for every caller, regardless of what that caller actually passes. Every
   * test call site here passes synchronous metadata and reads the result
   * synchronously, so `Tool` (not the Promise union) matches real usage;
   * callers with a schema-typed `execute` destructure should type the
   * parameter explicitly (or accept `params: unknown` and cast inside).
   */
  createTool: (configuration: unknown) => Tool;
};

function isMutableToolbox(value: AnyToolbox): value is MutableToolbox {
  return typeof (value as Partial<MutableToolbox>).register === 'function';
}

/**
 * Creates a toolbox typed for the legacy mutable test API
 * (`toolbox.register(...)`, `toolbox.createTool(...)`). Only valid under
 * `isTestRuntime()`, which every `bun test` run satisfies — see
 * `packages/armorer/src/create-toolbox.ts`'s `isTestRuntime()` guard.
 */
export function createMutableToolbox(
  entries: ToolboxEntries = [],
  options?: ToolboxOptions,
): MutableToolbox {
  const toolbox = createToolbox(entries, options) as AnyToolbox;
  if (!isMutableToolbox(toolbox)) {
    throw new Error(
      'createMutableToolbox() requires isTestRuntime() to be true; the legacy register/createTool convenience is not attached.',
    );
  }
  return toolbox;
}

export type { CreateToolOptions, Tool };
