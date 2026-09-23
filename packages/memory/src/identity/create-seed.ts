import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';

import type { SoulItem } from './types';

/**
 * Options for creating a seed soul.
 */
export interface CreateSoulSeedOptions {
  /** Agent name. */
  name?: string;
  /** Core personality traits (short descriptions). */
  traits?: string[];
  /** Non-negotiable values/boundaries. */
  values?: string[];
  /** Communication style preferences. */
  style?: string[];
  /** Any additional seed content. */
  additional?: string;
  /**
   * Runtime services to read identifiers and wall time from. Defaults to
   * the real implementation (`createDefaultRuntimeServices()`). A test
   * composes its own via `createManualRuntimeServices()` from `lifecycle`.
   */
  runtime?: RuntimeServices;
}

function createSeedItem(content: string, runtime: RuntimeServices, topic?: string): SoulItem {
  return {
    id: `seed-${runtime.identifiers.next('seed')}`,
    content,
    source: 'seed',
    pinned: true,
    ...(topic !== undefined ? { topic } : {}),
    updatedAt: runtime.clock.nowISO(),
    reinforcementCount: 0,
  };
}

function appendItems(
  items: SoulItem[],
  values: string[],
  topic: string,
  runtime: RuntimeServices,
): void {
  for (const value of values) items.push(createSeedItem(value, runtime, topic));
}

/**
 * Creates an initial soul from a minimal seed configuration.
 *
 * Each trait, value, and style becomes a separate SoulItem with
 * `source: 'seed'`, `pinned: true`, and `reinforcementCount: 0`.
 *
 * If no options are provided, returns a minimal default seed with
 * a single "You are a helpful assistant." item.
 */
export function createSoulSeed(options?: CreateSoulSeedOptions): SoulItem[] {
  const runtime = options?.runtime ?? createDefaultRuntimeServices();

  if (!options) {
    return [createSeedItem('You are a helpful assistant.', runtime)];
  }

  const items: SoulItem[] = [];

  if (options.name) {
    items.push(createSeedItem(`Your name is ${options.name}.`, runtime, 'identity'));
  }

  appendItems(items, options.traits ?? [], 'trait', runtime);
  appendItems(items, options.values ?? [], 'value', runtime);
  appendItems(items, options.style ?? [], 'style', runtime);

  if (options.additional) {
    items.push(createSeedItem(options.additional, runtime));
  }

  // If all arrays were empty and no name/additional, return default seed
  if (items.length === 0) {
    return [createSeedItem('You are a helpful assistant.', runtime)];
  }

  return items;
}
