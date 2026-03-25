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
          priority: entry.priority + priorityOffset,
        });
      }
    }
  }

  return merged;
}
