import { HookRegistry } from './hook-registry';
import type { HookMap } from './types';

export function mergeHookRegistries<M extends HookMap>(
  ...registries: (HookRegistry<M> | undefined)[]
): HookRegistry<M> {
  const filtered = registries.filter(
    (registry): registry is HookRegistry<M> => registry !== undefined,
  );

  const merged = new HookRegistry<M>();

  for (let registryIndex = 0; registryIndex < filtered.length; registryIndex++) {
    const registry = filtered[registryIndex]!;
    const priorityOffset = (filtered.length - 1 - registryIndex) * 1000;

    for (const hookName of registry.getHookNames()) {
      const handlers = registry.getHandlers(hookName);
      for (const entry of handlers) {
        merged.on(hookName, entry.handler, {
          ...entry.options,
          // The resolved id, not `entry.options.id`: a generated id lives on
          // the entry rather than the caller's options, and dropping it here
          // would mint a fresh one in the merged registry — so an observer
          // correlating by id would see the same registration under two names
          // either side of a merge.
          id: entry.id,
          priority: entry.priority + priorityOffset,
          // Materialize the SOURCE registry's error fallback onto the entry
          // (COR-1265). `merged` is constructed with no options, so after a
          // merge `dispatch()`'s `entry.options.onError ?? registryOptions.
          // onError` has nothing to fall back to — every tier's registry-level
          // `onError` would silently stop governing its own entries, and a
          // handler that used to be caught would throw uncaught. Each tier
          // keeps its own policy because the fallback is resolved per entry,
          // against the registry the entry actually came from, before the
          // entry leaves it.
          ...(entry.options.onError === undefined && registry.onError !== undefined
            ? { onError: registry.onError }
            : {}),
        });
      }
    }
  }

  return merged;
}
